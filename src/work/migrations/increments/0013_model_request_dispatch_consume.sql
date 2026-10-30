-- 0013: Register control-plane model requests as content references and let the
-- trusted egress consume a dispatch gate from the signed thin wire alone.
--
-- Authority: D4 §6.3 line `POST /runtime/v1/model/invoke` (payload
-- {executionId, requestRef, requestHash}; the token's operation/attempt/hash
-- must match online records and the atomic consume must still have exactly one
-- winner), D4 §7.1 (operation/attempt/fence/request_hash binding), and D1 §5.4
-- (one gate per Operation for its whole life; only the successful inserter is
-- told won; every conflict/retry/query is observed).
--
-- Node/egress hold no database login. The control plane calls the
-- SECURITY DEFINER commands as work_worker with an explicit tenant context.
-- This increment changes no body column and adds no table-level DML.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Content reference: model_request is a control-plane writer only
-- ---------------------------------------------------------------------------

ALTER TABLE work.content_reference
  DROP CONSTRAINT content_reference_kind_check;
ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_kind_check CHECK (kind IN (
    'input', 'template', 'checkpoint_candidate', 'model_request', 'answer',
    'receipt', 'rejection_evidence'
  ));

-- Receipts/answers/rejection evidence stay egress-only; inputs, templates and
-- the frozen model_request intent stay control-plane-only. A runtime child may
-- still only hold checkpoint_candidate slots.
ALTER TABLE work.content_reference
  DROP CONSTRAINT content_reference_kind_writer;
ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_kind_writer CHECK (
    (kind NOT IN ('receipt', 'answer', 'rejection_evidence')
      OR writer_kind = 'egress')
    AND (kind NOT IN ('input', 'template', 'model_request')
      OR writer_kind = 'control_plane')
    AND (writer_kind <> 'runtime_child' OR kind = 'checkpoint_candidate')
  );

-- The command layer must accept the new kind too. Same signature and same
-- idempotency/conflict semantics as 0011; only the kind and writer domain grow.
CREATE OR REPLACE FUNCTION work.register_content_reference(
  p_org_id text,
  p_ref_id uuid,
  p_task_id uuid,
  p_run_id uuid,
  p_execution_id uuid,
  p_kind text,
  p_logical_slot text,
  p_object_version text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_writer_kind text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  existing work.content_reference%ROWTYPE;
  v_exec_task_id uuid;
  v_exec_run_id uuid;
  v_run_task_id uuid;
  v_inserted uuid;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:ref_id' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
    'input', 'template', 'checkpoint_candidate', 'model_request', 'answer',
    'receipt', 'rejection_evidence'
  ) THEN
    RAISE EXCEPTION 'invalid_request:kind' USING ERRCODE = '22023';
  END IF;
  IF p_logical_slot IS NULL
     OR length(p_logical_slot) NOT BETWEEN 1 AND 512
     OR p_logical_slot ~ '[^A-Za-z0-9_.:@/-]' THEN
    RAISE EXCEPTION 'invalid_request:logical_slot' USING ERRCODE = '22023';
  END IF;
  IF p_object_version IS NULL
     OR length(p_object_version) NOT BETWEEN 1 AND 256
     OR p_object_version ~ '[^A-Za-z0-9_.:@+/=-]' THEN
    RAISE EXCEPTION 'invalid_request:object_version' USING ERRCODE = '22023';
  END IF;
  PERFORM work.assert_content_ref('content_ref', p_content_ref);
  PERFORM work.assert_document_hash('content_hash', p_content_hash);
  IF p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'invalid_request:bytes' USING ERRCODE = '22023';
  END IF;
  IF p_writer_kind IS NULL OR p_writer_kind NOT IN ('control_plane', 'egress') THEN
    RAISE EXCEPTION 'invalid_request:writer_kind' USING ERRCODE = '22023';
  END IF;

  IF p_run_id IS NOT NULL AND p_task_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:binding' USING ERRCODE = '22023';
  END IF;
  IF p_execution_id IS NOT NULL AND (p_task_id IS NULL OR p_run_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_request:binding' USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('receipt', 'answer', 'rejection_evidence')
     AND p_writer_kind <> 'egress' THEN
    RAISE EXCEPTION 'content_reference_writer_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IN ('input', 'template', 'model_request')
     AND p_writer_kind <> 'control_plane' THEN
    RAISE EXCEPTION 'content_reference_writer_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IN ('checkpoint_candidate', 'receipt') AND p_execution_id IS NULL THEN
    RAISE EXCEPTION 'content_reference_execution_required' USING ERRCODE = 'P0001';
  END IF;

  IF p_task_id IS NOT NULL THEN
    PERFORM 1 FROM work.task t
    WHERE t.id = p_task_id AND t.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF p_run_id IS NOT NULL THEN
    SELECT r.task_id INTO v_run_task_id
    FROM work.run r
    WHERE r.id = p_run_id AND r.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_run_task_id IS DISTINCT FROM p_task_id THEN
      RAISE EXCEPTION 'content_reference_binding_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_execution_id IS NOT NULL THEN
    SELECT e.task_id, e.run_id INTO v_exec_task_id, v_exec_run_id
    FROM work.runtime_execution e
    WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_exec_task_id IS DISTINCT FROM p_task_id
       OR v_exec_run_id IS DISTINCT FROM p_run_id THEN
      RAISE EXCEPTION 'content_reference_binding_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO existing
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.logical_slot = p_logical_slot
  FOR UPDATE;
  IF FOUND THEN
    IF existing.tombstoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001',
        DETAIL = 'tombstoned';
    END IF;
    IF existing.ref_id = p_ref_id
       AND existing.kind = p_kind
       AND existing.task_id IS NOT DISTINCT FROM p_task_id
       AND existing.run_id IS NOT DISTINCT FROM p_run_id
       AND existing.execution_id IS NOT DISTINCT FROM p_execution_id
       AND existing.object_version = p_object_version
       AND existing.content_ref = p_content_ref
       AND existing.content_hash = p_content_hash
       AND existing.bytes = p_bytes
       AND existing.writer_kind = p_writer_kind THEN
      RETURN jsonb_build_object('outcome', 'idempotent', 'ref_id', existing.ref_id);
    END IF;
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO work.content_reference
      (ref_id, org_id, task_id, run_id, execution_id, kind, logical_slot,
       object_version, content_ref, content_hash, bytes, writer_kind)
    VALUES
      (p_ref_id, p_org_id, p_task_id, p_run_id, p_execution_id, p_kind,
       p_logical_slot, p_object_version, p_content_ref, p_content_hash,
       p_bytes, p_writer_kind)
    ON CONFLICT ON CONSTRAINT content_reference_slot_unique DO NOTHING
    RETURNING ref_id INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    -- The only unhandled unique key left is ref_id: never let a replay alias a
    -- different logical slot onto an existing reference id.
    RAISE EXCEPTION 'content_reference_conflict' USING ERRCODE = 'P0001';
  END;
  IF v_inserted IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'registered', 'ref_id', v_inserted);
  END IF;

  -- Another transaction won the slot while this one was inserting. It must be
  -- the exact same binding to count as an idempotent replay.
  SELECT * INTO existing
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.logical_slot = p_logical_slot
  FOR UPDATE;
  IF FOUND
     AND existing.tombstoned_at IS NULL
     AND existing.ref_id = p_ref_id
     AND existing.kind = p_kind
     AND existing.task_id IS NOT DISTINCT FROM p_task_id
     AND existing.run_id IS NOT DISTINCT FROM p_run_id
     AND existing.execution_id IS NOT DISTINCT FROM p_execution_id
     AND existing.object_version = p_object_version
     AND existing.content_ref = p_content_ref
     AND existing.content_hash = p_content_hash
     AND existing.bytes = p_bytes
     AND existing.writer_kind = p_writer_kind THEN
    RETURN jsonb_build_object('outcome', 'idempotent', 'ref_id', existing.ref_id);
  END IF;
  RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
END;
$$;

-- ---------------------------------------------------------------------------
-- Send boundary by execution
-- ---------------------------------------------------------------------------

-- The egress thin wire carries only executionId/requestRef/requestHash. This
-- command re-reads every binding from the locked fragment instead of trusting
-- caller-supplied operation/attempt/holder/fence values:
--   * Task -> Run locks first, then the execution row is loaded FOR UPDATE;
--   * the fragment must be active with a live lease and hard deadline and the
--     Run/Task/fence must still be current;
--   * only an execute fragment with a complete immutable binding is eligible;
--   * the passed hash must equal the frozen execution hash (a different hash
--     never reaches the gate);
--   * the gate decision itself is delegated to consume_dispatch_delivery with
--     the derived operation/attempt/holder/run_fence, so exactly one insert
--     winner exists and every retry is observed.
CREATE FUNCTION work.consume_dispatch_by_execution(
  p_org_id text,
  p_execution_id uuid,
  p_request_hash text,
  p_gateway_invocation_id text,
  p_receipt_slot_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_run_id uuid;
  v_now timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_runtime_identifier('gateway_invocation_id', p_gateway_invocation_id);
  IF p_execution_id IS NULL OR p_request_hash IS NULL OR p_receipt_slot_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:consume_binding' USING ERRCODE = '22023';
  END IF;

  SELECT e.run_id INTO v_run_id
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;

  run_row := work.lock_runtime_run(p_org_id, v_run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.lease_until <= v_now OR execution_row.hard_deadline <= v_now THEN
    -- Refuse only; the expiry is committed by renew/register.
    RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.mode <> 'execute'
     OR execution_row.operation_id IS NULL
     OR execution_row.dispatch_attempt_id IS NULL
     OR execution_row.request_hash IS NULL THEN
    RAISE EXCEPTION 'runtime_execution_intent_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'runtime_request_hash_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- Same gate function as the full-wire path: the derived binding is locked
  -- and validated there, and only its single successful inserter gets won.
  RETURN work.consume_dispatch_delivery(
    p_org_id,
    execution_row.operation_id,
    p_execution_id,
    execution_row.holder_id,
    execution_row.dispatch_attempt_id,
    p_request_hash,
    execution_row.run_fence,
    p_gateway_invocation_id,
    p_receipt_slot_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: work_worker only (the control plane's internal authorization
-- module). No table-level DML and no EXECUTE for work_api/work_directory.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.consume_dispatch_by_execution(
  text, uuid, text, text, uuid
) FROM PUBLIC, work_api, work_directory, work_ledger, work_ops;

GRANT EXECUTE ON FUNCTION work.consume_dispatch_by_execution(
  text, uuid, text, text, uuid
) TO work_worker;

RESET ROLE;
