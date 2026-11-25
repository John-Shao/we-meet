SET ROLE work_owner;

CREATE FUNCTION work.governance_event_cursor_current(p_org_id text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN (SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = p_org_id);
END;
$$;

CREATE OR REPLACE FUNCTION work.consume_governance_events(
  p_org_id text,
  p_events jsonb,
  p_gap_attestation jsonb DEFAULT NULL,
  p_initialize_from bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  cursor_row work.governance_event_cursor%ROWTYPE;
  event_row record;
  v_env jsonb;
  v_last_seq bigint;
  v_expected_seq bigint;
  v_event_seq bigint;
  v_command_id uuid;
  v_kind text;
  v_desired boolean;
  v_subject text;
  v_member_revision bigint;
  v_payload_hash text;
  v_applied_at timestamptz;
  v_gap_report_id uuid := gen_random_uuid();
  v_consumed int := 0;
  v_released int := 0;
  v_released_code text;
  restriction_row work.access_restriction%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_gap_attestation IS NOT NULL
     AND COALESCE(p_gap_attestation ->> 'coverage', '') <> 'enumerated' THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO cursor_row FROM work.governance_event_cursor
  WHERE org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_initialize_from IS NULL OR p_initialize_from < 0 THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO work.governance_event_cursor (org_id, last_event_seq)
    VALUES (p_org_id, p_initialize_from)
    ON CONFLICT (org_id) DO NOTHING;
    SELECT * INTO cursor_row FROM work.governance_event_cursor
    WHERE org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_last_seq := cursor_row.last_event_seq;
  v_expected_seq := v_last_seq + 1;

  FOR event_row IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_env := event_row.value;
    BEGIN
      v_event_seq := (v_env ->> 'event_seq')::bigint;
      v_command_id := (v_env ->> 'command_id')::uuid;
      v_desired := (v_env ->> 'desired')::boolean;
      v_member_revision := (v_env ->> 'member_revision')::bigint;
      v_applied_at := (v_env ->> 'applied_at')::timestamptz;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END;
    v_kind := v_env ->> 'kind';
    v_subject := v_env ->> 'target_subject_id';
    v_payload_hash := v_env ->> 'payload_hash';
    IF v_event_seq IS NULL OR v_command_id IS NULL OR v_desired IS NULL
       OR v_applied_at IS NULL
       OR v_kind NOT IN ('seat', 'assignment', 'entitlement')
       OR COALESCE(v_payload_hash, '') !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END IF;
    IF v_kind = 'seat' THEN
      IF COALESCE(btrim(v_subject), '') = '' OR v_member_revision IS NULL THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
    ELSIF v_kind = 'assignment' THEN
      IF COALESCE(btrim(v_subject), '') = '' OR v_member_revision IS NOT NULL THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF v_subject IS NOT NULL OR v_member_revision IS NOT NULL THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
    END IF;

    IF v_event_seq <> v_expected_seq THEN
      IF v_event_seq < v_expected_seq THEN
        IF EXISTS (SELECT 1 FROM work.consumed_governance_command
                   WHERE org_id = p_org_id AND event_seq = v_event_seq) THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
      IF p_gap_attestation IS NULL
         OR COALESCE(p_gap_attestation ->> 'from_seq', '') !~ '^[0-9]+$'
         OR COALESCE(p_gap_attestation ->> 'to_seq_exclusive', '') !~ '^[0-9]+$'
         OR (p_gap_attestation ->> 'from_seq')::bigint <> v_expected_seq
         OR (p_gap_attestation ->> 'to_seq_exclusive')::bigint <> v_event_seq
         OR NOT work.governance_seat_events_valid(
              p_gap_attestation -> 'seat_events', v_expected_seq, v_event_seq) THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
      INSERT INTO work.governance_gap_report
        (org_id, gap_report_id, from_seq, to_seq_exclusive, seat_events,
         seat_event_count, host_fetch_seq)
      VALUES
        (p_org_id, v_gap_report_id, v_expected_seq, v_event_seq,
         p_gap_attestation -> 'seat_events',
         jsonb_array_length(p_gap_attestation -> 'seat_events'), v_event_seq);
      PERFORM work.append_audit(
        p_org_id, NULL, 'governance_gap_detected', 'governance_event_cursor', p_org_id,
        jsonb_build_object('gap_report_id', v_gap_report_id,
                           'from_seq', v_expected_seq,
                           'to_seq_exclusive', v_event_seq)
      );
      RETURN jsonb_build_object(
        'consumed', v_consumed, 'released', v_released,
        'last_event_seq', v_last_seq,
        'gap_report_id', v_gap_report_id,
        'from_seq', v_expected_seq, 'to_seq_exclusive', v_event_seq
      );
    END IF;

    IF EXISTS (SELECT 1 FROM work.consumed_governance_command
               WHERE org_id = p_org_id AND command_id = v_command_id) THEN
      IF NOT EXISTS (SELECT 1 FROM work.consumed_governance_command
                     WHERE org_id = p_org_id AND event_seq = v_event_seq) THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
      v_expected_seq := v_event_seq + 1;
      CONTINUE;
    END IF;

    INSERT INTO work.consumed_governance_command
      (org_id, command_id, kind, target_subject_id, desired, event_seq,
       member_revision, payload_hash, applied_at)
    VALUES
      (p_org_id, v_command_id, v_kind, v_subject, v_desired, v_event_seq,
       v_member_revision, v_payload_hash, v_applied_at);

    IF v_kind = 'seat' AND v_desired THEN
      FOR restriction_row IN
        SELECT id FROM work.access_restriction
        WHERE org_id = p_org_id
          AND source IN ('host_seat', 'work_seat_change')
          AND subject_id = v_subject
          AND state IN ('active', 'reconcile_required')
        ORDER BY id
      LOOP
        v_released_code := work.release_restriction(
          p_org_id, restriction_row.id, v_command_id, NULL, 'work_governance_events'
        );
        IF v_released_code IN ('released', 'already_released') THEN
          v_released := v_released + 1;
        END IF;
      END LOOP;
    END IF;

    v_consumed := v_consumed + 1;
    v_expected_seq := v_event_seq + 1;
    v_last_seq := v_event_seq;
    UPDATE work.governance_event_cursor
    SET last_event_seq = v_event_seq, updated_at = now()
    WHERE org_id = p_org_id;
  END LOOP;

  PERFORM work.append_audit(
    p_org_id, NULL, 'governance_events.consumed', 'governance_event_cursor', p_org_id,
    jsonb_build_object('consumed', v_consumed, 'released', v_released,
                       'last_event_seq', v_last_seq)
  );
  RETURN jsonb_build_object('consumed', v_consumed, 'released', v_released,
                            'last_event_seq', v_last_seq);
END;
$$;

CREATE FUNCTION work.record_governance_gap(
  p_org_id text,
  p_gap_attestation jsonb,
  p_host_fetch_seq bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_cursor bigint;
  v_from bigint;
  v_to bigint;
  v_report_id uuid := gen_random_uuid();
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_gap_attestation) <> 'object'
     OR COALESCE(p_gap_attestation ->> 'coverage', '') <> 'enumerated'
     OR COALESCE(p_gap_attestation ->> 'from_seq', '') !~ '^[0-9]+$'
     OR COALESCE(p_gap_attestation ->> 'to_seq_exclusive', '') !~ '^[0-9]+$'
     OR p_host_fetch_seq < 0 THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;
  v_from := (p_gap_attestation ->> 'from_seq')::bigint;
  v_to := (p_gap_attestation ->> 'to_seq_exclusive')::bigint;
  SELECT last_event_seq INTO v_cursor FROM work.governance_event_cursor
  WHERE org_id = p_org_id FOR UPDATE;
  IF NOT FOUND OR v_from <> v_cursor + 1 OR v_to <= v_from
     OR v_to > p_host_fetch_seq + 1 THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT work.governance_seat_events_valid(
       p_gap_attestation -> 'seat_events', v_from, v_to) THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM work.consumed_governance_command c
    WHERE c.org_id = p_org_id
      AND c.event_seq >= v_from AND c.event_seq < v_to
  ) THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO work.governance_gap_report
    (org_id, gap_report_id, from_seq, to_seq_exclusive, seat_events,
     seat_event_count, host_fetch_seq)
  VALUES
    (p_org_id, v_report_id, v_from, v_to,
     p_gap_attestation -> 'seat_events',
     jsonb_array_length(p_gap_attestation -> 'seat_events'), p_host_fetch_seq);
  PERFORM work.append_audit(
    p_org_id, NULL, 'governance_gap_detected', 'governance_event_cursor', p_org_id,
    jsonb_build_object('gap_report_id', v_report_id,
                       'from_seq', v_from,
                       'to_seq_exclusive', v_to)
  );
  RETURN jsonb_build_object('gap_report_id', v_report_id,
                            'from_seq', v_from, 'to_seq_exclusive', v_to);
END;
$$;

REVOKE ALL ON FUNCTION work.governance_event_cursor_current(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_governance_events(text, jsonb, jsonb, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_governance_gap(text, jsonb, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.governance_event_cursor_current(text) TO work_governance_events;
GRANT EXECUTE ON FUNCTION work.consume_governance_events(text, jsonb, jsonb, bigint) TO work_governance_events;
GRANT EXECUTE ON FUNCTION work.record_governance_gap(text, jsonb, bigint) TO work_governance_events;

RESET ROLE;
