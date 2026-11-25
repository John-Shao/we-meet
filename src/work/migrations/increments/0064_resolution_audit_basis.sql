-- 0064: persist the server facts behind an EV120 degradation verdict.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.issue_operation_resolution(
  p_org_id text, p_operation_id uuid, p_state text, p_code text, p_ticket_id text, p_signature text, p_actor_subject_id text, p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task_id uuid;
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  v_next_revision bigint;
  v_latest work.operation_resolution%ROWTYPE;
  v_settlement text;
  v_delivery text;
  v_target text;
  v_candidates int;
  v_basis jsonb;
  v_evidence jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_state NOT IN ('succeeded', 'failed', 'canceled', 'rejected_not_executed',
                     'undelivered', 'sealed_not_sent') THEN
    RAISE EXCEPTION 'invalid_request:state' USING ERRCODE = '22023';
  END IF;
  IF p_code IS NOT NULL
     AND p_code NOT IN ('evidence_unavailable', 'evidence_exhausted') THEN
    RAISE EXCEPTION 'invalid_request:code' USING ERRCODE = '22023';
  END IF;
  IF p_signature IS NULL OR p_signature !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'invalid_request:evidence' USING ERRCODE = '22023';
  END IF;

  SELECT r.task_id INTO v_task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = v_task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run
    WHERE id = (SELECT run_id FROM work.operation WHERE id = p_operation_id)
      AND org_id = p_org_id
    FOR UPDATE;
  SELECT * INTO operation_row FROM work.operation
    WHERE id = p_operation_id AND org_id = p_org_id
    FOR UPDATE;

  IF operation_row.step_key IS NULL THEN
    RAISE EXCEPTION 'operation_not_local' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO gate_row
  FROM work.dispatch_delivery
    WHERE org_id = p_org_id AND operation_id = p_operation_id;

  SELECT * INTO v_latest
  FROM work.operation_resolution
    WHERE org_id = p_org_id AND operation_id = p_operation_id
    ORDER BY resolution_revision DESC
    LIMIT 1;
  IF FOUND THEN
    IF v_latest.state = p_state
       AND v_latest.code IS NOT DISTINCT FROM p_code THEN
      IF v_latest.signature = p_signature THEN
        RETURN jsonb_build_object('resolve_id', v_latest.resolve_id,
                                  'resolution_revision', v_latest.resolution_revision,
                                  'settlement_state', v_latest.settlement_state,
                                  'delivery_state', v_latest.delivery_state,
                                  'replayed', true);
      END IF;
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF v_latest.code IS NOT NULL OR p_code IS NOT NULL THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_code IS NULL THEN
    IF operation_row.state IN ('succeeded', 'failed', 'canceled', 'reconciled') THEN
      RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF operation_row.state NOT IN ('unknown', 'unresolved') THEN
      RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
    END IF;
    IF gate_row.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF p_code = 'evidence_unavailable' AND operation_row.kind <> 'tool' THEN
      RAISE EXCEPTION 'evidence_unavailable_scope_denied' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM work.operation_usage_fact f
      WHERE f.org_id = p_org_id AND f.operation_id = p_operation_id
    ) OR operation_row.usage_recorded_at IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(operation_row.provider_request_id, '') <> ''
       OR COALESCE(operation_row.receipt_ref, '') <> '' THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF p_code = 'evidence_unavailable' THEN
      IF NOT (
        EXISTS (
          SELECT 1 FROM work.execution_lease l
          WHERE l.org_id = p_org_id AND l.run_id = operation_row.run_id
            AND (l.state <> 'active' OR l.expires_at <= now())
        )
        OR EXISTS (
          SELECT 1 FROM work.device d
          JOIN work.device_run_binding b
            ON b.device_id = d.id AND b.org_id = d.org_id
          WHERE d.org_id = p_org_id AND b.run_id = operation_row.run_id
            AND d.status = 'revoked'
        )
      ) THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
      IF (p_evidence ->> 'journal_unavailable') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF p_code = 'evidence_exhausted' THEN
      IF COALESCE(btrim(p_ticket_id), '') = '' THEN
        RAISE EXCEPTION 'invalid_request:ticket_id' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM work.device_session s
        JOIN work.device_run_binding b
          ON b.session_id = s.id AND b.org_id = s.org_id
        WHERE s.org_id = p_org_id AND b.run_id = operation_row.run_id
          AND s.state = 'active' AND s.expires_at > now()
      ) THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
      IF NOT (
        EXISTS (
          SELECT 1 FROM work.execution_lease l
          WHERE l.org_id = p_org_id AND l.run_id = operation_row.run_id
            AND (l.state <> 'active' OR l.expires_at <= now())
        )
        OR EXISTS (
          SELECT 1 FROM work.device d
          JOIN work.device_run_binding b
            ON b.device_id = d.id AND b.org_id = d.org_id
          WHERE d.org_id = p_org_id AND b.run_id = operation_row.run_id
            AND d.status = 'revoked'
        )
      ) THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  SELECT min(m.operation_state), count(*) INTO v_target, v_candidates
  FROM work.resolution_state_map m
  JOIN work.state_transition e
    ON e.entity = 'operation' AND e.from_state = operation_row.state
   AND e.to_state = m.operation_state
  WHERE m.resolution_state = p_state;
  IF v_target IS NULL OR v_candidates <> 1
     OR (p_code IS NOT NULL AND v_target <> 'reconciled') THEN
    RAISE EXCEPTION 'resolution_target_unreachable' USING ERRCODE = 'P0001';
  END IF;

  v_delivery := CASE
    WHEN gate_row.gate_state IS NULL THEN 'not_applicable'
    WHEN gate_row.gate_state = 'sealed_not_sent' THEN 'undelivered'
    ELSE 'delivered'
  END;

  IF p_code IS NOT NULL THEN
    v_settlement := 'unknown';
  ELSE
    SELECT q.state INTO v_settlement
    FROM work.quota_reservation q
    WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
    ORDER BY q.reservation_seq DESC
    LIMIT 1;
    v_settlement := COALESCE(v_settlement, 'unknown');
  END IF;

  SELECT COALESCE(MAX(resolution_revision), 0) + 1 INTO v_next_revision
  FROM work.operation_resolution
  WHERE org_id = p_org_id AND operation_id = p_operation_id;

  v_evidence := p_evidence;
  IF p_code IS NOT NULL THEN
    v_basis := jsonb_build_object(
      'checked_at', clock_timestamp(),
      'leases', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'lease_id', l.id, 'device_id', l.device_id, 'session_id', l.session_id,
          'state', l.state, 'expires_at', l.expires_at
        ) ORDER BY l.expires_at, l.id)
        FROM work.execution_lease l
        WHERE l.org_id = p_org_id AND l.run_id = operation_row.run_id
          AND (l.state <> 'active' OR l.expires_at <= now())
      ), '[]'::jsonb),
      'revoked_devices', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'device_id', d.id, 'status', d.status, 'revoked_at', d.revoked_at
        ) ORDER BY d.id)
        FROM work.device d
        JOIN work.device_run_binding b
          ON b.device_id = d.id AND b.org_id = d.org_id
        WHERE d.org_id = p_org_id AND b.run_id = operation_row.run_id
          AND d.status = 'revoked'
      ), '[]'::jsonb),
      'active_session_count', (
        SELECT count(*) FROM work.device_session s
        JOIN work.device_run_binding b
          ON b.session_id = s.id AND b.org_id = s.org_id
        WHERE s.org_id = p_org_id AND b.run_id = operation_row.run_id
          AND s.state = 'active' AND s.expires_at > now()
      ),
      'journal_attestation', CASE WHEN p_code = 'evidence_unavailable'
        THEN jsonb_build_object(
          'journal_unavailable', p_evidence ->> 'journal_unavailable',
          'provenance', 'caller_attestation'
        ) ELSE NULL END,
      'receipt_ref', operation_row.receipt_ref,
      'receipt_present', COALESCE(operation_row.receipt_ref, '') <> '',
      'provider_request_id', operation_row.provider_request_id,
      'provider_request_present', COALESCE(operation_row.provider_request_id, '') <> '',
      'usage_fact_count', (
        SELECT count(*) FROM work.operation_usage_fact f
        WHERE f.org_id = p_org_id AND f.operation_id = p_operation_id
      ),
      'dispatch_gate_present', gate_row.operation_id IS NOT NULL,
      'dispatch_gate_state', gate_row.gate_state,
      'ticket_id', NULLIF(btrim(COALESCE(p_ticket_id, '')), '')
    );
    v_evidence := v_evidence || jsonb_build_object('server_basis', v_basis);
  END IF;

  INSERT INTO work.operation_resolution
    (org_id, run_id, operation_id, resolution_revision, resolve_id, attempt_id,
     state, delivery_state, code, usage_source, settlement_state, signature,
     evidence, ticket_id)
  VALUES
    (p_org_id, operation_row.run_id, p_operation_id, v_next_revision,
     gen_random_uuid(), operation_row.dispatch_attempt_id, p_state,
     v_delivery, p_code,
     CASE WHEN p_code IS NULL THEN NULL ELSE 'unavailable' END,
     v_settlement, p_signature,
     v_evidence || jsonb_build_object(
       'operation_state_before', operation_row.state,
       'operation_state_after', v_target,
       'reservation_held', EXISTS (SELECT 1 FROM work.quota_reservation q
                                   WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
                                     AND q.state = 'held'),
       'reservations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                     'seq', q.reservation_seq, 'state', q.state)
                                   ORDER BY q.reservation_seq)
                                FROM work.quota_reservation q
                                WHERE q.org_id = p_org_id
                                  AND q.operation_id = p_operation_id), '[]'::jsonb)),
     NULLIF(btrim(COALESCE(p_ticket_id, '')), ''));

  UPDATE work.operation
  SET state = v_target, revision = revision + 1, updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;

  IF run_row.state = 'waiting' AND run_row.wait_reason = 'reconcile' THEN
    UPDATE work.run
    SET wait_reason = 'input', control_revision = control_revision + 1, updated_at = now()
    WHERE id = run_row.id AND org_id = p_org_id;
  END IF;

  PERFORM work.append_task_event(
    p_org_id, v_task_id,
    CASE WHEN v_target = 'reconciled' THEN 'operation.reconciled' ELSE 'operation.settled' END,
    jsonb_build_object('operation_id', p_operation_id, 'state', p_state,
                       'operation_state', v_target,
                       'code', p_code, 'settlement_state', v_settlement,
                       'delivery_state', v_delivery)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'operation.resolution_issued',
    'operation', p_operation_id::text,
    jsonb_build_object('state', p_state, 'operation_state', v_target, 'code', p_code,
                       'ticket_id', NULLIF(btrim(COALESCE(p_ticket_id, '')), ''),
                       'resolution_revision', v_next_revision,
                       'settlement_state', v_settlement,
                       'delivery_state', v_delivery,
                       'evidence', v_evidence)
  );
  RETURN jsonb_build_object(
    'resolve_id', (SELECT resolve_id FROM work.operation_resolution
                   WHERE org_id = p_org_id AND operation_id = p_operation_id
                     AND resolution_revision = v_next_revision),
    'resolution_revision', v_next_revision,
    'operation_state', v_target,
    'settlement_state', v_settlement,
    'delivery_state', v_delivery,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION work.list_run_reconciliations(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_items jsonb;
  v_blocking boolean;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.assert_session_subject(p_actor_subject_id);
  SELECT * INTO run_row FROM work.run WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task
    WHERE org_id = p_org_id AND id = run_row.task_id
      AND owner_subject_id = p_actor_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY item ->> 'operation_id'), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'operation_id', o.id,
      'kind', o.kind,
      'operation_state', o.state,
      'reconcile_requested_at', o.reconcile_requested_at,
      'waited_seconds', CASE
        WHEN o.reconcile_requested_at IS NULL THEN NULL
        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - o.reconcile_requested_at)))::bigint)
      END,
      'resolution_state', CASE degradation.code
        WHEN 'evidence_unavailable' THEN 'downgraded_readonly'
        WHEN 'evidence_exhausted' THEN 'evidence_exhausted'
        ELSE 'pending'
      END,
      'evidence_sources', CASE
        WHEN degradation.evidence IS NULL OR jsonb_typeof(degradation.evidence) <> 'object' THEN '[]'::jsonb
        ELSE (SELECT COALESCE(jsonb_agg(source_key ORDER BY source_key), '[]'::jsonb)
              FROM jsonb_object_keys(degradation.evidence) AS source_key
              WHERE source_key NOT IN ('operation_state_before', 'operation_state_after',
                                       'reservation_held', 'reservations', 'server_basis'))
      END,
      'ticket_id', degradation.ticket_id,
      'has_authoritative_evidence', (
        EXISTS (SELECT 1 FROM work.operation_usage_fact f
                WHERE f.org_id = o.org_id AND f.operation_id = o.id)
        OR o.usage_recorded_at IS NOT NULL
        OR COALESCE(o.provider_request_id, '') <> ''
        OR COALESCE(o.receipt_ref, '') <> ''
        OR EXISTS (SELECT 1 FROM work.dispatch_delivery d
                   WHERE d.org_id = o.org_id AND d.operation_id = o.id)
      ),
      'contact_path', CASE degradation.code
        WHEN 'evidence_exhausted' THEN 'operator_ticket'
        WHEN 'evidence_unavailable' THEN 'wait_for_late_evidence'
        ELSE 'wait_for_reconciliation'
      END
    ) AS item
    FROM work.operation o
    LEFT JOIN LATERAL (
      SELECT r.code, r.evidence, r.ticket_id
      FROM work.operation_resolution r
      WHERE r.org_id = o.org_id AND r.operation_id = o.id AND r.code IS NOT NULL
      ORDER BY r.resolution_revision DESC
      LIMIT 1
    ) degradation ON TRUE
    WHERE o.org_id = p_org_id AND o.run_id = p_run_id
      AND (o.state IN ('unknown', 'unresolved') OR degradation.code IS NOT NULL)
  ) waiting_operations;

  v_blocking := work.task_has_blocking_operation(run_row.task_id, p_org_id);
  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'run_id', p_run_id,
    'task_id', run_row.task_id,
    'run_state', run_row.state,
    'wait_reason', run_row.wait_reason,
    'blocking', jsonb_build_object(
      'new_run', v_blocking,
      'acceptance', v_blocking OR EXISTS (
        SELECT 1 FROM work.operation_resolution r
        JOIN work.operation o ON o.id = r.operation_id AND o.org_id = r.org_id
        JOIN work.run rn ON rn.id = o.run_id AND rn.org_id = o.org_id
        WHERE r.org_id = p_org_id AND rn.task_id = run_row.task_id
          AND r.code = 'evidence_exhausted'
      )
    ),
    'items', v_items
  );
END;
$$;

RESET ROLE;
