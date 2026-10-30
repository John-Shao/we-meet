SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.reconcile_operation(
  p_org_id text,
  p_operation_id uuid,
  p_resolution text,
  p_provider_request_id text DEFAULT NULL,
  p_settled_tokens bigint DEFAULT 0,
  p_evidence_ref text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  reservation work.quota_reservation%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  next_revision int;
  v_provider_request_id text := p_provider_request_id;
  v_evidence_ref text := p_evidence_ref;
BEGIN
  IF p_resolution = 'rejected_not_executed' THEN
    PERFORM work.assert_runtime_context(p_org_id);
  END IF;
  IF p_resolution NOT IN ('sent_succeeded', 'not_sent', 'unresolved',
                          'rejected_not_executed') THEN
    RAISE EXCEPTION 'invalid_reconciliation_resolution' USING ERRCODE = '22023';
  END IF;
  IF p_settled_tokens < 0 THEN
    RAISE EXCEPTION 'invalid_settlement_amount' USING ERRCODE = '22023';
  END IF;
  IF p_resolution IN ('sent_succeeded', 'not_sent', 'rejected_not_executed')
     AND (p_evidence_ref IS NULL OR p_evidence_ref = '') THEN
    RAISE EXCEPTION 'reconciliation_evidence_required' USING ERRCODE = '22023';
  END IF;
  IF p_resolution = 'rejected_not_executed' AND p_settled_tokens IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'rejected_receipt_requires_zero_settlement' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF p_resolution = 'rejected_not_executed' THEN
    SELECT * INTO gate_row
    FROM work.dispatch_delivery d
    WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id;
    IF gate_row.operation_id IS NULL THEN
      RAISE EXCEPTION 'dispatch_gate_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF gate_row.gate_state <> 'receipt_recorded' THEN
      RAISE EXCEPTION 'dispatch_receipt_not_bound' USING ERRCODE = 'P0001',
        DETAIL = gate_row.gate_state;
    END IF;
    IF gate_row.receipt_result <> 'rejected_not_executed' THEN
      RAISE EXCEPTION 'dispatch_receipt_not_rejection' USING ERRCODE = 'P0001',
        DETAIL = COALESCE(gate_row.receipt_result, '');
    END IF;
    IF gate_row.receipt_ref IS NULL OR gate_row.receipt_ref = '' THEN
      RAISE EXCEPTION 'rejection_evidence_missing' USING ERRCODE = 'P0001';
    END IF;
    IF p_evidence_ref <> gate_row.receipt_ref THEN
      RAISE EXCEPTION 'rejection_evidence_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF operation_row.usage_recorded_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM work.operation_usage_fact f
      WHERE f.org_id = p_org_id AND f.operation_id = p_operation_id
    ) OR EXISTS (
      SELECT 1 FROM work.quota_reservation q
      WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
        AND q.settled_tokens > 0
    ) THEN
      RAISE EXCEPTION 'rejection_usage_conflict' USING ERRCODE = 'P0001';
    END IF;
    v_provider_request_id := gate_row.provider_request_id;
    v_evidence_ref := gate_row.receipt_ref;
  END IF;
  IF operation_row.state = 'reconciled' THEN
    IF p_resolution = 'rejected_not_executed'
       AND operation_row.receipt_ref IS DISTINCT FROM v_evidence_ref THEN
      RAISE EXCEPTION 'rejection_evidence_mismatch' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF operation_row.state = 'unresolved' AND p_resolution = 'unresolved' THEN
    RETURN;
  END IF;
  IF operation_row.state NOT IN ('unknown', 'unresolved') THEN
    RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO reservation
  FROM work.quota_reservation
  WHERE operation_id = p_operation_id AND org_id = p_org_id
  ORDER BY reservation_seq DESC
  LIMIT 1
  FOR UPDATE;
  IF p_resolution = 'sent_succeeded' THEN
    IF reservation.id IS NULL THEN
      RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
    END IF;
    next_revision := reservation.settlement_revision + 1;
    PERFORM work.settle_quota(
      reservation.id, p_settled_tokens,
      jsonb_build_object('resolution', p_resolution, 'evidence_ref', p_evidence_ref),
      next_revision
    );
  ELSIF p_resolution IN ('not_sent', 'rejected_not_executed') THEN
    IF reservation.id IS NOT NULL AND reservation.state = 'held' THEN
      PERFORM work.release_quota(reservation.id);
    ELSIF reservation.id IS NOT NULL AND reservation.state = 'unknown' THEN
      next_revision := reservation.settlement_revision + 1;
      PERFORM work.settle_quota(
        reservation.id, 0,
        jsonb_build_object('resolution', p_resolution, 'evidence_ref', v_evidence_ref),
        next_revision
      );
    END IF;
  END IF;
  UPDATE work.operation
  SET state = CASE WHEN p_resolution = 'unresolved' THEN 'unresolved' ELSE 'reconciled' END,
      provider_request_id = COALESCE(v_provider_request_id, provider_request_id),
      receipt_ref = COALESCE(v_evidence_ref, receipt_ref),
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id,
    CASE WHEN p_resolution = 'unresolved' THEN 'operation.unresolved' ELSE 'operation.reconciled' END,
    jsonb_build_object(
      'operation_id', p_operation_id,
      'resolution', p_resolution,
      'settled_tokens', CASE WHEN p_resolution = 'rejected_not_executed' THEN 0 ELSE p_settled_tokens END,
      'evidence_ref', v_evidence_ref
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL,
    CASE WHEN p_resolution = 'unresolved' THEN 'operation.unresolved' ELSE 'operation.reconcile' END,
    'operation', p_operation_id::text,
    jsonb_build_object(
      'resolution', p_resolution,
      'settled_tokens', CASE WHEN p_resolution = 'rejected_not_executed' THEN 0 ELSE p_settled_tokens END,
      'evidence_ref', v_evidence_ref
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION work.reconcile_operation(
  text, uuid, text, text, bigint, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.reconcile_operation(
  text, uuid, text, text, bigint, text
) TO work_worker;

RESET ROLE;
