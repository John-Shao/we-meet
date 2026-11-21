
-- 0061: let a RECONNECTED session hand back the finish of its OWN still-active run (J12
-- cross-session reconcile_finish; execution-face batch 6).
--
-- WHY: 0040:820-821 already carves the execution_lease purpose 'reconcile_finish', and 0059
--   already taught work.acquire_device_lease to MINT one — fresh mint requires only that the
--   caller's device owns the run's binding at that revision (0059:618, device_id only) and the
--   Run is 'active', binding the lease to the CALLER's live session (0059:645) with no run_start,
--   no checkpoint baseline and no execution capability (EV113: prepare_local_operation and
--   consume_device_permit both require purpose='execute'). Three gates still refused the hand-back.
--   On the finish side, work.finish_local_run's ownership block required
--   v_binding.session_id = v_lease.session_id (0059:804). But a reconnect mints a NEW session
--   (0040:1644-1647, activate_device_session supersedes) while device_run_binding.session_id is
--   guard-IMMUTABLE (0040:963) and stays on the superseded session — so a finish of the run's own
--   history was unreachable, exactly the gap 0053's header registered as deferred (J12 lease
--   "hand back history ... unreachable today"). On the mint side, the run's stale execute lease
--   occupied the one-active-lease-per-run slot; change 2 is what makes change 1 reachable.
--
-- CHANGE 1: finish_local_run (same 9-argument signature, so CREATE OR REPLACE keeps its work_worker
--   EXECUTE grant — 0059:947/951). In the ownership block, the binding-vs-lease SESSION equality
--   is enforced ONLY for purpose='execute'. For 'reconcile_finish' it is skipped; every other
--   guard is kept verbatim: gate 1 validates the caller device + its live, unexpired,
--   auth-plane/epoch-matched session (0059:733-748); the lease still belongs to the CALLING device
--   AND the CALLING session (0059:807), the binding still belongs to the same device as the lease
--   (v_binding.device_id = v_lease.device_id), the fence must equal run.fence (0059:819), and the
--   full precondition set (checkpoint/receipt continuity, recomputed operation-set hash, the
--   completed deliverable gate, the terminal write) is unchanged. So the relaxation admits ONLY
--   the same device recovering its own active run across a supersession of its own session — it
--   never lets one device finish another's run, which is what 0053 gate 2 exists to stop.
--
-- CHANGE 2: acquire_device_lease (same 8-argument signature, same grant treatment) is restated so
--   change 1 is actually reachable, because the mint it presupposes was not. Change 1 removes the
--   finish-side refusal; the mint-side refusal is work_execution_lease_one_active_per_run
--   (0040:876), which is PURPOSE-agnostic, combined with the fact that nothing expires a device
--   lease on its own: renew_device_lease only extends an active row and never flips state
--   (0051:121-124) and there is no sweeper. So a reconnect that lands inside the crashed execute
--   lease's 30s TTL (the normal case — §3.3's heartbeat is 10s) found no active reconcile_finish row
--   at 0059:548-550, fell to the fresh mint, and died on 23505 inside the INSERT at 0059:641. The
--   gateway mapped that to Internal service_degraded and the device could not hand its finish in at
--   all — J12's "expired lease -> ask for a new reconcile_finish lease" (0051:112, EV113) had no
--   executable path. The mint therefore now reclaims the slot in the same transaction, immediately
--   before its own INSERT: it sets state='expired' on THIS run's active 'execute' lease of the
--   CALLING device whose owning session activate_device_session has already terminalized
--   (0040:1644-1647). The positive-form session test is the scope: a lease whose session is still
--   active is never disarmed, and since a device has at most one active session the caller can
--   never expire the lease it is standing on. The execute branch never enters the block and the
--   row keeps expires_at/fence/last_receipt_seq as the evidence of what it was. The
--   one-active-lease-per-run invariant itself stands unchanged.
--
-- CHANGE 3: the same relaxation change 1 applies to the finish, applied to the mint's REPLAY
--   branch. That branch (0059:587-590) re-checks the binding against the CALLER's session, but the
--   fresh-mint path only ever checked its device (0059:618). So under 0059 a reconcile_finish lease
--   minted by a reconnected session could be obtained once and then never replayed: the second
--   lease_acquire — which is what an uplink retry, a heartbeat-scale re-drive or the device's own
--   next finish attempt sends — answered unauthorized, and the device lost the lease it had just
--   been granted with no way to get it back. Gating that equality on purpose = 'execute' makes the
--   replay branch agree with the mint branch it replays, and is the same bounded claim as change 1:
--   the caller already had to prove it owns that exact lease on its own live session (0059:575-578,
--   device_id AND session_id), so the only fact the removed equality could add was that the
--   binding's (immutable, superseded) session equalled the caller's — which is precisely what J12
--   says cannot hold for a hand-back. An execute replay keeps its check verbatim.
--
-- No new table, column, trigger, index, error code or privilege; both functions keep their
-- signatures, so no REVOKE/GRANT restatement and no idempotency-key command is added
-- (idempotency_contract_test.go:81-82 inventories by signature parameter, unchanged).
-- renew_device_lease and the offer getter are untouched. Tip moves 0060 -> 0061; the deployed
-- rollout set is unchanged (still 39).

SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.finish_local_run(
  p_org_id text,
  p_run_id uuid,
  p_finish_id uuid,
  p_lease_id uuid,
  p_binding_revision bigint,
  p_fence bigint,
  p_finish jsonb,
  p_device_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_checkpoint work.device_checkpoint%ROWTYPE;
  v_existing work.device_run_finish%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_outcome text;
  v_run_outcome text;
  v_reason text;
  v_reject text;
  v_set_hash text;
  v_max_seq bigint;
  v_receipt_through bigint;
  v_unresolved jsonb;
  v_terminal bigint;
  v_signed_hash text;
  v_server_signature text;
  v_response jsonb;
  v_version_id uuid;
  v_deliverable_ok boolean := true;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  IF NOT work.local_run_finish_valid(p_finish) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_outcome := p_finish ->> 'outcome';
  v_reason := p_finish ->> 'reason_code';
  IF v_outcome NOT IN ('completed', 'failed')
     OR COALESCE(p_finish ->> 'final_checkpoint_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'final_operation_set_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'device_signature', '') !~ '^[A-Za-z0-9_-]{86}$'
     OR COALESCE(p_finish ->> 'final_checkpoint_seq', '') !~ '^[0-9]+$'
     OR COALESCE(p_finish ->> 'receipt_through_seq', '') !~ '^[0-9]+$'
     OR (v_outcome = 'completed' AND v_reason IS NOT NULL)
     OR (v_reason IS NOT NULL AND v_reason NOT IN
         ('no_deliverable', 'model_error', 'tool_limit', 'runtime_limit_exceeded',
          'runtime_unresumable', 'checkpoint_lost', 'input_missing')) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_signed_hash := work.sha256_text(p_finish ->> 'device_signature');

  SELECT * INTO v_existing FROM work.device_run_finish
    WHERE org_id = p_org_id AND run_id = p_run_id AND finish_id = p_finish_id;
  IF FOUND THEN
    IF v_existing.signed_payload_hash IS DISTINCT FROM v_signed_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'finish_id', p_finish_id, 'state', v_existing.state,
      'code', v_existing.reject_code,
      'terminal_run_revision', v_existing.terminal_run_revision,
      'expected_operation_set_hash', v_existing.final_operation_set_hash,
      'unresolved_operations', v_existing.unresolved_operations,
      'server_signature', v_existing.server_signature, 'replayed', true);
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> p_run_id OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now()
     OR v_lease.binding_revision IS DISTINCT FROM p_binding_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = p_binding_revision FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id <> v_lease.device_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- The binding must share the lease's session for an execute lease (0059:804). For a
  -- reconcile_finish lease the binding's session is a superseded session of the SAME device by
  -- construction — the whole point of minting the reconcile_finish lease after a reconnect — so
  -- that equality is skipped; v_binding.device_id = v_lease.device_id (above) plus the caller
  -- checks below keep it bound to the caller's device.
  IF v_lease.purpose = 'execute' AND v_binding.session_id <> v_lease.session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_lease.device_id <> p_device_id OR v_lease.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = v_lease.device_id;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = v_lease.session_id;

  v_reject := NULL;
  v_set_hash := work.local_operation_set_hash(p_org_id, p_run_id);
  v_unresolved := '[]'::jsonb;

  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    v_reject := 'stale_fence';
  END IF;

  IF v_reject IS NULL THEN
    IF v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
      v_reject := 'finish_precondition_failed';
    ELSIF v_run.state = 'cancel_requested' AND v_outcome = 'completed' THEN
      v_reject := 'run_cancel_requested';
    END IF;
  END IF;

  IF v_reject IS NULL THEN
    SELECT COALESCE(MAX(checkpoint_seq), -1) INTO v_max_seq
      FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded';
    SELECT * INTO v_checkpoint FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND checkpoint_seq = (p_finish ->> 'final_checkpoint_seq')::bigint;
    SELECT COALESCE(MAX(seq), 0) INTO v_receipt_through FROM work.device_receipt
      WHERE org_id = p_org_id AND device_id = v_lease.device_id
        AND journal_epoch = v_session.journal_epoch;
    IF (p_finish ->> 'final_checkpoint_seq')::bigint IS DISTINCT FROM v_max_seq
       OR v_checkpoint.checkpoint_hash IS DISTINCT FROM
          (p_finish ->> 'final_checkpoint_hash')
       OR (p_finish ->> 'receipt_through_seq')::bigint IS DISTINCT FROM v_receipt_through
       OR v_checkpoint.receipt_through_seq > v_receipt_through
       OR (p_finish ->> 'final_operation_set_hash') IS DISTINCT FROM v_set_hash THEN
      v_reject := 'finish_state_mismatch';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('operation_id', o.id,
                                                   'state', o.state)), '[]'::jsonb)
        INTO v_unresolved
      FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                        'unknown', 'unresolved');
    END IF;
  END IF;

  IF v_reject IS NULL AND v_outcome = 'completed' THEN
    IF EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                        'unknown', 'unresolved')
    ) OR EXISTS (
      SELECT 1 FROM work.device_dispatch d
      JOIN work.operation o ON o.id = d.operation_id AND o.org_id = d.org_id
      WHERE d.org_id = p_org_id AND o.run_id = p_run_id
        AND d.delivery_state IN ('pending', 'undelivered')
    ) THEN
      v_reject := 'finish_precondition_failed';
    ELSE
      FOR v_version_id IN
        SELECT (x #>> '{}')::uuid
        FROM jsonb_array_elements(p_finish -> 'deliverable_versions') x
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM work.artifact_version av
          WHERE av.org_id = p_org_id AND av.version_id = v_version_id
            AND av.state = 'published' AND av.location = 'local_only'
            AND av.classification = 'local_only'
            AND av.provenance ->> 'run_id' = p_run_id::text
        ) THEN
          v_deliverable_ok := false;
        END IF;
      END LOOP;
      IF jsonb_array_length(p_finish -> 'deliverable_versions') = 0
         OR NOT v_deliverable_ok THEN
        v_reject := 'finish_precondition_failed';
      END IF;
    END IF;
  END IF;

  v_server_signature := 'sha256:' || work.sha256_text('run_finish|' || p_run_id::text
    || '|' || p_finish_id::text || '|' || v_outcome || '|'
    || COALESCE(v_reject, 'accepted') || '|' || v_set_hash);

  IF v_reject IS NOT NULL THEN
    INSERT INTO work.device_run_finish
      (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
       reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
       final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
       reject_code, terminal_run_revision, server_signature, unresolved_operations)
    VALUES
      (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
       v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
       p_finish ->> 'final_checkpoint_hash',
       (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
       p_finish -> 'deliverable_versions', v_signed_hash, 'rejected', v_reject, NULL,
       v_server_signature, v_unresolved);
    PERFORM work.append_audit(p_org_id, NULL, 'run.finish_local_rejected',
      'run', p_run_id::text,
      jsonb_build_object('finish_id', p_finish_id, 'code', v_reject,
        'expected_operation_set_hash', v_set_hash));
    RETURN jsonb_build_object('finish_id', p_finish_id, 'state', 'rejected',
      'code', v_reject, 'terminal_run_revision', NULL,
      'expected_operation_set_hash', v_set_hash, 'unresolved_operations', v_unresolved,
      'server_signature', v_server_signature, 'replayed', false);
  END IF;

  v_run_outcome := CASE v_outcome WHEN 'completed' THEN 'succeeded' ELSE 'failed' END;
  v_terminal := work.finish_local_run_state(p_org_id, p_run_id, v_run_outcome, v_reason);

  INSERT INTO work.device_run_finish
    (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
     reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
     final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
     reject_code, terminal_run_revision, server_signature, unresolved_operations)
  VALUES
    (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
     v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
     p_finish ->> 'final_checkpoint_hash',
     (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
     p_finish -> 'deliverable_versions', v_signed_hash, 'accepted', NULL, v_terminal,
     v_server_signature, v_unresolved);

  v_response := jsonb_build_object('finish_id', p_finish_id, 'state', 'accepted',
    'code', NULL, 'terminal_run_revision', v_terminal,
    'expected_operation_set_hash', v_set_hash, 'unresolved_operations', v_unresolved,
    'server_signature', v_server_signature);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;


CREATE OR REPLACE FUNCTION work.acquire_device_lease(
  p_org_id text,
  p_run_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_binding_revision bigint,
  p_purpose text,
  p_start_nonce uuid,
  p_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_org work.org%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_id uuid;
  v_expiry timestamptz;
  v_baseline_hash text;
  v_has_checkpoint boolean;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF p_purpose IS NULL OR p_purpose NOT IN ('execute', 'reconcile_finish')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 30
     OR p_binding_revision IS NULL OR p_binding_revision < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'execute' AND p_start_nonce IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'reconcile_finish' AND p_start_nonce IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF p_purpose = 'execute' THEN
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND start_nonce = p_start_nonce
      FOR UPDATE;
  ELSE
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND purpose = 'reconcile_finish'
        AND state = 'active' FOR UPDATE;
  END IF;
  IF FOUND THEN
    IF v_lease.device_id IS DISTINCT FROM p_device_id
       OR v_lease.session_id IS DISTINCT FROM p_session_id
       OR v_lease.binding_revision IS DISTINCT FROM p_binding_revision
       OR v_lease.purpose IS DISTINCT FROM p_purpose THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
    IF v_lease.state <> 'active' OR v_lease.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_binding FROM work.device_run_binding
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision = v_lease.binding_revision;
    -- CHANGE 3 below is what makes this branch reachable from a reconnected session: the binding
    -- of a superseded session is guard-immutable and names that dead session, so the execute-only
    -- form of the session test is the same relaxation change 1 applies on the finish side.
    IF NOT FOUND OR v_binding.device_id IS DISTINCT FROM p_device_id
       OR (v_lease.purpose = 'execute'
           AND v_binding.session_id IS DISTINCT FROM p_session_id) THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_device FROM work.device
      WHERE org_id = p_org_id AND id = p_device_id;
    IF NOT FOUND OR v_device.status <> 'active' THEN
      RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_session FROM work.device_session
      WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id;
    IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= clock_timestamp()
       OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
       OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
    -- Renewals can change lease.expires_at, never the original run_start or its
    -- five-second delivery window. Audit is already the receipt carrier; retain
    -- the exact first response there, including the original checkpoint fields.
    SELECT metadata -> 'response' INTO v_response FROM work.audit_event
      WHERE org_id = p_org_id AND action = 'device_lease.acquired'
        AND metadata ->> 'lease_id' = v_lease.id::text;
    -- Pre-0059 leases have no saved response. Do not invent their original TTL,
    -- baseline, or delivery deadline from a possibly renewed current lease.
    IF v_response IS NULL OR (p_purpose = 'execute' AND
        (v_response #>> '{run_start,expiry}')::timestamptz <= clock_timestamp()) THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state <> 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id;
  IF NOT FOUND OR v_session.state <> 'active' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id AND binding_revision = p_binding_revision
    FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id IS DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_purpose = 'execute' THEN
    IF EXISTS (SELECT 1 FROM work.operation
        WHERE org_id = p_org_id AND run_id = p_run_id
          AND state IN ('unknown', 'unresolved')) THEN
      RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
    END IF;
    IF v_binding.state NOT IN ('ready', 'active') THEN
      RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
    END IF;
    SELECT EXISTS (SELECT 1 FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded')
      INTO v_has_checkpoint;
    IF v_binding.expected_checkpoint_seq IS NULL AND v_has_checkpoint THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 0061 change 2: the reconcile_finish mint reclaims the run's single active-lease slot.
  -- work_execution_lease_one_active_per_run (0040:876) is purpose-agnostic and nothing else
  -- expires a device lease (renew only extends an active row, 0051:121, and there is no
  -- sweeper), so a reconnect that lands inside the crashed execute lease's TTL collided with
  -- that index on the INSERT below and the hand-back lease could not be minted at all. Expire
  -- exactly the row the reconnect superseded: this run, the calling device, purpose 'execute',
  -- still 'active', and an owning session activate_device_session has already terminalized
  -- (0040:1644-1647). The positive-form session test is what keeps it narrow: a lease whose
  -- session is still active is never disarmed, and because a device has at most one active
  -- session the caller can never be expiring the very lease it is standing on. active ->
  -- expired is whitelisted (0040:183) and neither column is in execution_lease_guard's
  -- immutable set (0040:848-858); the row keeps expires_at, fence and last_receipt_seq as the
  -- evidence of what it was, which is also how 0042's terminal write releases a lease.
  IF p_purpose = 'reconcile_finish' THEN
    UPDATE work.execution_lease
      SET state = 'expired', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'active'
        AND purpose = 'execute' AND device_id = p_device_id
        AND EXISTS (SELECT 1 FROM work.device_session dead
                    WHERE dead.org_id = p_org_id AND dead.id = execution_lease.session_id
                      AND dead.state <> 'active');
  END IF;

  v_id := gen_random_uuid();
  v_expiry := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO work.execution_lease
    (org_id, id, run_id, device_id, session_id, binding_revision, fence, generation,
     purpose, start_nonce, expires_at)
  VALUES
    (p_org_id, v_id, p_run_id, p_device_id, p_session_id, p_binding_revision,
     v_run.fence, COALESCE(v_org.access_epoch, 0), p_purpose,
     CASE WHEN p_purpose = 'execute' THEN p_start_nonce ELSE NULL END, v_expiry);

  IF p_purpose = 'execute' THEN
    UPDATE work.device_run_binding
      SET state = 'active', updated_at = now(), revision = revision + 1
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision = p_binding_revision AND state = 'ready';

    IF NOT EXISTS (SELECT 1 FROM work.device_checkpoint
        WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = 0) THEN
      v_baseline_hash := v_binding.input_hash;
      INSERT INTO work.device_checkpoint
        (org_id, run_id, checkpoint_seq, binding_revision, fence, checkpoint_hash,
         local_ref, receipt_through_seq, pending_operation_set_hash, signed_payload_hash)
      VALUES
        (p_org_id, p_run_id, 0, p_binding_revision, v_run.fence, v_baseline_hash,
         v_binding.input_ref, 0, work.sha256_text('[]'), NULL);
    END IF;
  END IF;

  v_response := jsonb_build_object('lease_id', v_id, 'run_id', p_run_id, 'fence', v_run.fence,
    'generation', COALESCE(v_org.access_epoch, 0), 'purpose', p_purpose,
    'expires_at', v_expiry, 'ttl_ms', p_ttl_seconds * 1000,
    'start_nonce', CASE WHEN p_purpose = 'execute' THEN p_start_nonce ELSE NULL END,
    'run_start', CASE WHEN p_purpose = 'execute' THEN jsonb_build_object(
      'run_binding_id', p_binding_revision, 'run_id', p_run_id, 'lease_id', v_id,
      'fence', v_run.fence, 'start_nonce', p_start_nonce,
      'expiry', LEAST(v_expiry, now() + interval '5 seconds'),
      'runtime_digest', v_binding.runtime_digest,
      'payload_hash', work.sha256_text('run_start|' || p_run_id::text || '|'
        || p_binding_revision::text || '|' || v_id::text || '|' || p_start_nonce::text))
      ELSE NULL END,
    'checkpoint_seq', CASE WHEN p_purpose = 'execute' THEN 0 ELSE NULL END,
    'checkpoint_hash', CASE WHEN p_purpose = 'execute' THEN v_binding.input_hash ELSE NULL END);
  PERFORM work.append_audit(p_org_id, NULL, 'device_lease.acquired',
    'run', p_run_id::text,
    jsonb_build_object('lease_id', v_id, 'purpose', p_purpose, 'fence', v_run.fence,
      'start_nonce', p_start_nonce, 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

RESET ROLE;
