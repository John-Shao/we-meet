-- 0073: bind governance cursor recovery to Host's org.work.seat.write permission.
SET ROLE work_owner;

-- Rollout may apply migrations before swapping work-api. Keep the old signature
-- resolvable but fail closed until the seven-argument caller is deployed.
CREATE OR REPLACE FUNCTION work.advance_governance_event_cursor(
  p_org_id text,
  p_to_seq bigint,
  p_gap_report_id uuid,
  p_ticket_id text,
  p_actor_subject_id text,
  p_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.assert_session_subject(p_actor_subject_id);
  RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION work.advance_governance_event_cursor(
  p_org_id text,
  p_to_seq bigint,
  p_gap_report_id uuid,
  p_ticket_id text,
  p_actor_subject_id text,
  p_request_id text,
  p_actor_permissions text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  cursor_row work.governance_event_cursor%ROWTYPE;
  report_row work.governance_gap_report%ROWTYPE;
  v_prior jsonb;
  v_prior_hash text;
  v_request_hash text;
  v_affected int := 0;
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id
      AND m.subject_id = p_actor_subject_id
      AND m.status = 'active'
  ) OR NOT (
    'org.work.seat.write' = ANY(COALESCE(p_actor_permissions, ARRAY[]::text[]))
  ) THEN
    RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_ticket_id), '') = '' OR COALESCE(btrim(p_request_id), '') = '' THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  v_request_hash := work.sha256_text(jsonb_build_object(
    'actor_subject_id', p_actor_subject_id,
    'to_seq', p_to_seq,
    'gap_report_id', p_gap_report_id,
    'ticket_id', p_ticket_id
  )::text);

  SELECT * INTO cursor_row FROM work.governance_event_cursor
    WHERE org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  SELECT metadata -> 'result', metadata ->> 'request_hash'
    INTO v_prior, v_prior_hash
  FROM work.audit_event
  WHERE org_id = p_org_id
    AND action = 'governance_gap_skipped'
    AND metadata ->> 'request_id' = p_request_id;
  IF v_prior IS NOT NULL THEN
    IF v_prior_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prior;
  END IF;

  SELECT * INTO report_row FROM work.governance_gap_report
    WHERE org_id = p_org_id AND gap_report_id = p_gap_report_id FOR UPDATE;
  IF NOT FOUND
     OR report_row.state <> 'pending'
     OR report_row.from_seq <> cursor_row.last_event_seq + 1
     OR report_row.to_seq_exclusive <> p_to_seq
     OR p_to_seq <= cursor_row.last_event_seq THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  IF NOT work.governance_seat_events_valid(
         report_row.seat_events, report_row.from_seq, report_row.to_seq_exclusive) THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(report_row.seat_events) AS se
    JOIN work.consumed_governance_command c
      ON c.org_id = p_org_id
     AND (c.command_id = lower((se ->> 'command_id'))::uuid
          OR c.event_seq = (se ->> 'event_seq')::bigint)
  ) OR EXISTS (
    SELECT 1 FROM work.consumed_governance_command c
    WHERE c.org_id = p_org_id
      AND c.event_seq >= report_row.from_seq
      AND c.event_seq < report_row.to_seq_exclusive
  ) THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO work.consumed_governance_command
    (org_id, command_id, kind, target_subject_id, desired, event_seq,
     member_revision, payload_hash, applied_at, gap_skipped)
  SELECT p_org_id, lower(se ->> 'command_id')::uuid, 'seat',
         se ->> 'target_subject_id', (se ->> 'desired')::boolean,
         (se ->> 'event_seq')::bigint, (se ->> 'member_revision')::bigint,
         se ->> 'payload_hash', (se ->> 'applied_at')::timestamptz, true
  FROM jsonb_array_elements(report_row.seat_events) AS se;

  UPDATE work.access_restriction r
  SET state = 'reconcile_required', revision = revision + 1, updated_at = now()
  WHERE r.org_id = p_org_id
    AND r.state = 'active'
    AND r.source IN ('host_seat', 'work_seat_change')
    AND EXISTS (
      SELECT 1 FROM work.consumed_governance_command c
      WHERE c.org_id = p_org_id
        AND c.gap_skipped
        AND c.kind = 'seat'
        AND c.desired
        AND c.event_seq >= report_row.from_seq
        AND c.event_seq < report_row.to_seq_exclusive
        AND c.target_subject_id = r.subject_id
        AND c.member_revision > r.release_floor_revision
    );
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  UPDATE work.governance_gap_report
    SET state = 'consumed', updated_at = now()
    WHERE org_id = p_org_id AND gap_report_id = p_gap_report_id;
  UPDATE work.governance_event_cursor
    SET last_event_seq = p_to_seq, updated_at = now()
    WHERE org_id = p_org_id;

  v_result := jsonb_build_object(
    'org_id', p_org_id,
    'last_event_seq', p_to_seq,
    'gap_report_id', p_gap_report_id
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'governance_gap_skipped', 'governance_event_cursor',
    p_org_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'request_hash', v_request_hash,
      'ticket_id', p_ticket_id,
      'gap_report_id', p_gap_report_id,
      'from_seq', report_row.from_seq,
      'to_seq_exclusive', report_row.to_seq_exclusive,
      'seat_event_count', report_row.seat_event_count,
      'reconcile_required', v_affected,
      'result', v_result
    )
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text) TO work_api;
REVOKE ALL ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text, text[]) TO work_api;

RESET ROLE;
