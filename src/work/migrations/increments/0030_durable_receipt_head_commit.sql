-- Increment 0030 (#82 = F1): commit the answer a dead parent already paid for.
--
-- The 2026-11-06 SIGKILL drill produced exactly one Run this cannot close: the provider
-- answer and its receipt were durable (consumed 08:44:23, receipt_recorded 08:44:28), the
-- lease elapsed and was taken over (08:48:33), the Run parked in wait_reason='reconcile',
-- and an operator resumed it 2h27m after hard_deadline. FinishAdvance published the artifact
-- and settled the Operation from the receipt, then commit_runtime_checkpoint refused its own
-- `hard_deadline <= now()` guard and the activity reported finish_head_conflict. The Run kept
-- state='active' with a published artifact: a wrong state, not a wrong bill.
--
-- CREATE OR REPLACE keeps the published ACL of 0009:1707/1730, so no GRANT changes here.
-- Only the guard block and the audit payload change below; the body is the text of increment
-- 0009 read at this tip, so the replay short-circuit, the run_not_current check, the base
-- equality check, the CAS and the writes are byte-for-byte the ones in production use.
CREATE OR REPLACE FUNCTION work.commit_runtime_checkpoint(
  p_org_id text,
  p_run_id uuid,
  p_execution_id uuid,
  p_expected_revision bigint,
  p_expected_ref text,
  p_expected_hash text,
  p_checkpoint_ref text,
  p_checkpoint_hash text,
  p_runtime_version text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  execution_row work.runtime_execution%ROWTYPE;
  head_row work.runtime_checkpoint_head%ROWTYPE;
  v_now timestamptz;
  v_revision bigint;
  v_after_deadline boolean := false;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_content_ref('checkpoint_ref', p_checkpoint_ref);
  PERFORM work.assert_document_hash('checkpoint_hash', p_checkpoint_hash);
  PERFORM work.assert_runtime_identifier('runtime_version', p_runtime_version);
  IF (p_expected_ref IS NULL) <> (p_expected_hash IS NULL)
     OR (p_expected_revision IS NULL) <> (p_expected_hash IS NULL) THEN
    RAISE EXCEPTION 'invalid_request:expected_base' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision < 0 THEN
    RAISE EXCEPTION 'invalid_request:expected_revision' USING ERRCODE = '22023';
  END IF;

  run_row := work.lock_runtime_run(p_org_id, p_run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF execution_row.execution_id IS NULL OR execution_row.run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO head_row
  FROM work.runtime_checkpoint_head h
  WHERE h.org_id = p_org_id AND h.run_id = p_run_id
  FOR UPDATE;
  v_now := clock_timestamp();

  -- Replay of an already committed candidate: historical answer, no overwrite.
  IF head_row.run_id IS NOT NULL
     AND head_row.committed_execution_id = p_execution_id
     AND head_row.checkpoint_hash = p_checkpoint_hash
     AND head_row.checkpoint_ref = p_checkpoint_ref THEN
    RETURN head_row.checkpoint_revision;
  END IF;

  IF execution_row.state IN ('revoked', 'expired') THEN
    RAISE EXCEPTION 'runtime_execution_revoked' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.lease_until <= v_now OR execution_row.hard_deadline <= v_now THEN
    -- The refusal stays the default for every caller. The single exception is the shape
    -- increment 0028 exists for, taken one step further: the parent is gone AND the step was
    -- already paid for. The evidence is the gate row itself - a receipt recorded against this
    -- exact execution, operation and dispatch attempt, with a success result - which is what
    -- makes committing its successor bookkeeping rather than a new send. Nothing here can buy
    -- a second provider call: work.consume_dispatch_delivery still refuses any consume once
    -- the deadline has passed, and this arm never touches the lease or the holder, because
    -- taking over a lease is how one acquires the right to do work that is not yet done.
    v_after_deadline := execution_row.hard_deadline <= v_now
      AND EXISTS (
        SELECT 1 FROM work.dispatch_delivery d
        WHERE d.org_id = p_org_id
          AND d.execution_id = p_execution_id
          AND d.operation_id = execution_row.operation_id
          AND d.attempt_id = execution_row.dispatch_attempt_id
          AND d.gate_state = 'receipt_recorded'
          AND d.receipt_result = 'success'
          AND d.receipt_slot_id IS NOT NULL
      );
    IF NOT v_after_deadline THEN
      RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.input_checkpoint_hash IS DISTINCT FROM p_expected_hash
     OR execution_row.input_checkpoint_ref IS DISTINCT FROM p_expected_ref THEN
    RAISE EXCEPTION 'runtime_checkpoint_base_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF head_row.run_id IS NULL THEN
    IF p_expected_revision IS NOT NULL THEN
      RAISE EXCEPTION 'runtime_checkpoint_head_missing' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO work.runtime_checkpoint_head
      (org_id, run_id, task_id, checkpoint_revision, checkpoint_ref, checkpoint_hash,
       runtime_version, committed_execution_id)
    VALUES
      (p_org_id, p_run_id, run_row.task_id, 0, p_checkpoint_ref, p_checkpoint_hash,
       p_runtime_version, p_execution_id);
    v_revision := 0;
  ELSE
    IF p_expected_revision IS NULL
       OR head_row.checkpoint_revision <> p_expected_revision
       OR head_row.checkpoint_ref <> p_expected_ref
       OR head_row.checkpoint_hash <> p_expected_hash THEN
      RAISE EXCEPTION 'runtime_checkpoint_cas_conflict' USING ERRCODE = 'P0001',
        DETAIL = head_row.checkpoint_revision::text;
    END IF;
    v_revision := head_row.checkpoint_revision + 1;
    UPDATE work.runtime_checkpoint_head h
    SET checkpoint_revision = v_revision,
        checkpoint_ref = p_checkpoint_ref,
        checkpoint_hash = p_checkpoint_hash,
        runtime_version = p_runtime_version,
        committed_execution_id = p_execution_id,
        updated_at = now()
    WHERE h.org_id = p_org_id AND h.run_id = p_run_id;
  END IF;

  UPDATE work.runtime_execution e
  SET state = 'completed', lease_until = NULL, terminal_reason = 'checkpoint_committed',
      revision = e.revision + 1, updated_at = now()
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.checkpoint_committed', 'run', p_run_id::text,
    jsonb_build_object(
      'execution_id', p_execution_id, 'checkpoint_revision', v_revision::text,
      'checkpoint_hash', p_checkpoint_hash,
      'durable_receipt_after_deadline', CASE WHEN v_after_deadline THEN 'true' ELSE 'false' END,
      'expected_revision',
      CASE WHEN p_expected_revision IS NULL THEN NULL ELSE p_expected_revision::text END
    )
  );
  RETURN v_revision;
END;
$$;
