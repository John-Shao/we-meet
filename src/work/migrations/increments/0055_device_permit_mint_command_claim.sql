-- 0055: server-minted SignedPermit and the device command claim (M3 gateway GW14, P0 #1).
--
-- 主签 2026-11-17 四项单选：① 许可原文存 device_dispatch 新增 permit 列（不另建 permit 表）；
-- ② 设备 issued_at/expires_at 改 RFC3339（SQL 铸造即按 RFC3339 输出）；③ command 下行帧本身也
-- 服务端签名；④ 本批一次闭合动作脊。方向裁定来自 GW13：consume 内部铸造＋独立 permit 签名键。
--
-- WHY THE RESTATEMENT. 0042's consume_device_permit took the 28-key permit as an INPUT
-- (p_permit jsonb), compared every field against a server fact, and echoed it back
-- (0042:1516). Nothing in the chain minted or signed it, and work_worker has no SELECT on
-- local_action / workspace_grant / device_session / device_dispatch (0024), so the gateway
-- could not build it either. device-design §3.3 requires signing AFTER the dispatch CAS with
-- only the CAS winner holding a deliverable permit, and control-design §4.2's consume row
-- describes the CAS, never a presented token. The input-permit shape was therefore both
-- uncallable and out of order. This increment makes consume MINT the permit from the facts it
-- already reads, after the CAS, and store the original document so a replay returns the SAME
-- jti (§3.3 forbids re-signing a new jti for the same action).
--
-- WHY A COLUMN AND NOT A TABLE. 0042:1234 already ruled that "there is no permit table:
-- SignedPermit is a stateless token, and a second table would be a second single-use
-- authority". The single-use authority stays the pair of UNIQUE keys on device_dispatch plus
-- the authorized -> dispatching CAS; the permit column is evidence, not a second authority.
-- It is guard-immutable like every other content column. The stored `signature` is the
-- INTERNAL sha256 placeholder (operation_resolution.signature / device_run_finish.server_signature
-- precedent): plpgsql cannot sign ES256 (0040:1135), so the gateway signs the wire document
-- under the "permit" domain with its INDEPENDENT permit key and never writes the result back.
--
-- APPLICABILITY. The column is NOT NULL with no DEFAULT, so this increment requires an EMPTY
-- device_dispatch: a row written by 0042's input-permit consume has no stored document to
-- backfill, and inventing one would fabricate execution authority. That precondition holds on
-- every path this repo can reach — the deployed tip is 39 (before device_dispatch exists), and
-- 0042-0055 are the M3 line, outside the ruled rollout package, so no production device has
-- consumed a permit. It is recorded as a precondition rather than papered over with a backfill.
--
-- WHAT COLLAPSED AND WHAT DID NOT. Minting from server facts makes the old token-vs-fact
-- comparisons tautologies, so they are replaced by the mint itself rather than kept as dead
-- checks: the permit field-shape block (0042:1284-1302), permit.fence vs p_fence, the identity
-- block's org/subject/device/session/agent_instance/boot/generation/run/operation/attempt
-- comparisons, aud vs the derived audience, grant_id/grant_revision, policy_epoch/access_epoch,
-- destination_id/max_bytes, scope_hash vs its own recomputation, and approval_id/
-- decision_revision (including the ELSIF that refused a non-null approval_id on an
-- auto-approved action — the mint now emits null there, which is what the readonly path needs).
-- EVERY fact gate is preserved verbatim and in the original refusal order: org context,
-- request_hash/kid shape, replay + idempotency_key_conflict, operation_not_found, the
-- Task/Run/Operation locks, local_action existence, dispatch_attempt_id match, device
-- unrevoked, session active/owned/unexpired/plane+epoch, lease run/device/session/active/
-- unexpired, fence against BOTH run.fence and lease.fence (stale_fence), request_hash against
-- v_operation.request_hash (still a caller input, NOT vacuous), the TTL bounds (permit_expired
-- stays reachable: expires_at is minted at now()+5s and REFUSED rather than shortened when it
-- would exceed the remaining lease, which is 0042's landed behavior), grant state/expiry/
-- revision, approval status/expiry, invariant 3's second enforcement point
-- (run_has_unreconciled_operation), the (A) destination gate re-evaluated from server facts
-- (destination_not_allowed_for_local_only), classification_floor_required, the quota
-- re-verification (O-14 = jia, quota_reservation_not_held) and the single CAS
-- (operation_not_authorizable). A device_permit_valid self-check on the minted document keeps
-- the closed 28-key set enforced.
--
-- THE CLAIM. claim_pending_device_commands is the heartbeat-driven entry point, because no
-- worker -> gateway signal exists: an ask_each action becomes authorized only when the user
-- decides it through the M1b REST face, and the gateway learns of it on the next heartbeat
-- (GW11's offer-push precedent). It is a combined claim like 0049's resolution claim: it
-- dispatches every authorized action of this device's active Runs that has no dispatch row,
-- then returns every live dispatch of THIS device and session. A refused candidate is skipped
-- inside a subtransaction and stays authorized for the next heartbeat — a domain refusal (a
-- revoked grant, a stale approval) must not become a transport failure that kills the session.
-- delivery_state is deliberately NOT advanced: only not_applicable -> superseded is registered
-- (0042:503), §3.1 has no command_ack frame, and delivery is confirmed by the device's receipt.
-- The gateway dedups per stream so a heartbeat does not nag (GW11 precedent); cross-session
-- re-push stays out of scope because hello supersedes the session and a new session cannot
-- renew the old lease (GW10 boundary).
--
-- No new public error code is registered: every code raised here is already in
-- contracts/error-codes.json db_exception_map, and the raising surface is the gRPC device
-- plane, not the HTTP public API (0051/0053/0054 precedent). No table privilege is granted.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- 1. The permit document becomes durable evidence on the dispatch row.
-- ---------------------------------------------------------------------------
ALTER TABLE work.device_dispatch ADD COLUMN permit jsonb NOT NULL;
ALTER TABLE work.device_dispatch ADD CONSTRAINT device_dispatch_permit_shape
  CHECK (work.device_permit_valid(permit));

CREATE OR REPLACE FUNCTION work.device_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.journal_epoch IS DISTINCT FROM OLD.journal_epoch
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.permit_jti IS DISTINCT FROM OLD.permit_jti
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.permit IS DISTINCT FROM OLD.permit
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_dispatch_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. consume_device_permit: mint internally, after the CAS.
-- ---------------------------------------------------------------------------
DROP FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, jsonb);

CREATE FUNCTION work.consume_device_permit(
  p_org_id text,
  p_operation_id uuid,
  p_attempt_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_lease_id uuid,
  p_fence bigint,
  p_request_hash text,
  p_kid text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_action work.local_action%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_approval work.approval%ROWTYPE;
  v_existing work.device_dispatch%ROWTYPE;
  v_reservation work.quota_reservation%ROWTYPE;
  v_command_id uuid;
  v_jti uuid;
  v_taint integer;
  v_scope_hash text;
  v_aud text;
  v_permit jsonb;
  v_response jsonb;
  v_approval_id uuid;
  v_issued_at text;
  v_expires_at text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF COALESCE(p_request_hash, '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_kid, '') = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Replay first, now keyed on the dispatch primary key instead of a presented jti: the
  -- permit is server-minted, so the caller holds no jti to present. The same (operation,
  -- attempt) is the same dispatch, and the stored document is returned unchanged so the
  -- gateway re-signs the SAME jti rather than minting a second one (§3.3).
  SELECT * INTO v_existing FROM work.device_dispatch
    WHERE org_id = p_org_id AND operation_id = p_operation_id AND attempt_id = p_attempt_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'command_id', v_existing.command_id, 'permit_jti', v_existing.permit_jti,
      'operation_id', v_existing.operation_id,
      'dispatch_attempt_id', v_existing.attempt_id, 'fence', v_existing.fence,
      'expires_at', v_existing.expires_at, 'delivery_state', v_existing.delivery_state,
      'permit', v_existing.permit, 'replayed', true);
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run r
    JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
    WHERE o.org_id = p_org_id AND o.id = p_operation_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id
      AND id = (SELECT run_id FROM work.operation
                WHERE org_id = p_org_id AND id = p_operation_id)
    FOR UPDATE;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
  SELECT * INTO v_action FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_operation.dispatch_attempt_id IS DISTINCT FROM p_attempt_id THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

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
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> v_run.id OR v_lease.device_id <> p_device_id
     OR v_lease.session_id <> p_session_id OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    RAISE EXCEPTION 'stale_fence' USING ERRCODE = 'P0001';
  END IF;

  -- The one identity comparison that is NOT vacuous after minting: request_hash is still a
  -- caller input and must equal the Operation's own hash.
  IF p_request_hash IS DISTINCT FROM v_operation.request_hash THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- aud matches the action class; device-egress was moved out by card E=B.
  v_aud := CASE WHEN v_action.action_kind IN ('model.send_remote',
                                            'model.send_device_local')
                THEN 'device-model-proxy' ELSE 'device-tool' END;

  -- TTL: at most five seconds, and never beyond the remaining lease. The values are minted
  -- here (RFC3339, whole seconds, the form every landed frame carries) and REFUSED rather
  -- than shortened when the lease cannot cover them, which is 0042's landed behavior and
  -- keeps permit_expired reachable.
  v_issued_at := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_expires_at := to_char((now() + interval '5 seconds') AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  IF v_expires_at::timestamptz <= now()
     OR v_expires_at::timestamptz > now() + interval '5 seconds'
     OR v_expires_at::timestamptz > v_lease.expires_at
     OR v_issued_at::timestamptz > now() THEN
    RAISE EXCEPTION 'permit_expired' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_grant FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = v_action.grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.state <> 'active' OR v_grant.expires_at <= now()
     OR v_grant.grant_revision IS DISTINCT FROM v_action.grant_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;

  -- scope_hash is recomputed from the server's own action row, in a fixed key order, and
  -- becomes the minted value rather than being compared against a presented one.
  v_scope_hash := work.sha256_text('{"action_kind":"' || v_action.action_kind
    || '","grant_id":"' || v_action.grant_id::text
    || '","grant_revision":' || v_action.grant_revision
    || ',"resource_selector_hash":"' || v_action.resource_selector_hash
    || '","classification":"' || v_action.classification
    || '","destination_id":' || CASE WHEN v_action.destination_id IS NULL THEN 'null'
         ELSE '"' || v_action.destination_id || '"' END || '}');

  SELECT ao.approval_id INTO v_approval_id FROM work.approval_operation ao
    WHERE ao.org_id = p_org_id AND ao.operation_id = p_operation_id;
  IF v_approval_id IS NOT NULL THEN
    SELECT * INTO v_approval FROM work.approval
      WHERE org_id = p_org_id AND id = v_approval_id FOR UPDATE;
    IF v_approval.status <> 'approved' OR v_approval.expires_at <= now() THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Invariant 3, second enforcement point: an unknown that appeared AFTER prepare
  -- still blocks the dispatch.
  IF EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = v_run.id
      AND o.state IN ('unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;

  -- (A) again, from server facts, with the same input set as prepare.
  IF v_action.action_kind IN ('model.send_remote', 'model.send_device_local')
     AND v_action.destination_id <> 'device_local' THEN
    SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0) INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
    WHERE la.org_id = p_org_id AND o.run_id = v_run.id
      AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');
    IF v_taint >= work.classification_rank('local_only') THEN
      RAISE EXCEPTION 'destination_not_allowed_for_local_only' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF work.classification_rank(v_action.classification)
     < work.classification_rank(v_grant.classification) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  -- O-14 = jia: re-verify only. No reservation is created here.
  SELECT * INTO v_reservation FROM work.quota_reservation q
    WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
    ORDER BY q.reservation_seq DESC LIMIT 1;
  IF FOUND AND v_reservation.state NOT IN ('held', 'unknown') THEN
    RAISE EXCEPTION 'quota_reservation_not_held' USING ERRCODE = 'P0001';
  END IF;

  -- The single CAS. Only the winner gets a deliverable permit.
  UPDATE work.operation
    SET state = 'dispatching', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_operation_id AND state = 'authorized';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_authorizable' USING ERRCODE = 'P0001';
  END IF;

  -- The mint, AFTER the CAS (§3.3). Every value is a server fact read above; the uint64
  -- fields cross as decimal strings (§3.1). approval_id and decision_revision are null on
  -- the readonly auto-approved path, which has no Approval row. The signature is the
  -- internal placeholder: the gateway signs the wire document with the permit key.
  v_jti := gen_random_uuid();
  v_permit := jsonb_build_object(
    'v', 2,
    'aud', v_aud,
    'kid', p_kid,
    'jti', v_jti,
    'org_id', p_org_id,
    'subject_id', v_task.owner_subject_id,
    'device_id', p_device_id::text,
    'session_id', p_session_id::text,
    'agent_instance_id', v_session.agent_instance_id::text,
    'boot_id', v_session.boot_id,
    'generation', v_session.generation::text,
    'run_id', v_run.id::text,
    'operation_id', p_operation_id::text,
    'dispatch_attempt_id', p_attempt_id::text,
    'request_hash', p_request_hash,
    'fence', p_fence::text,
    'policy_epoch', v_policy.effective_epoch::text,
    'access_epoch', v_run.admission_access_epoch::text,
    'grant_id', v_action.grant_id::text,
    'grant_revision', v_action.grant_revision::text,
    'approval_id', v_approval_id,
    'decision_revision', CASE WHEN v_approval_id IS NULL THEN NULL
                              ELSE v_approval.revision::text END,
    'scope_hash', v_scope_hash,
    'destination_id', v_action.destination_id,
    'max_bytes', v_action.byte_upper_bound::text,
    'issued_at', v_issued_at,
    'expires_at', v_expires_at,
    'signature', 'sha256:' || work.sha256_text(v_scope_hash || '|' || v_jti::text));
  IF NOT work.device_permit_valid(v_permit) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_command_id := gen_random_uuid();
  INSERT INTO work.device_dispatch
    (org_id, operation_id, attempt_id, device_id, session_id, journal_epoch,
     command_id, permit_jti, request_hash, fence, expires_at, delivery_state, permit)
  VALUES
    (p_org_id, p_operation_id, p_attempt_id, p_device_id, p_session_id,
     v_session.journal_epoch, v_command_id, v_jti, p_request_hash, p_fence,
     v_expires_at::timestamptz, 'not_applicable', v_permit);

  PERFORM work.append_task_event(p_org_id, v_task.id, 'operation.dispatched',
    jsonb_build_object('operation_id', p_operation_id, 'command_id', v_command_id,
      'attempt_id', p_attempt_id, 'fence', p_fence));
  PERFORM work.append_audit(p_org_id, NULL, 'device_permit.consumed',
    'operation', p_operation_id::text,
    jsonb_build_object('command_id', v_command_id,
      'permit_jti', v_jti, 'attempt_id', p_attempt_id,
      'aud', v_aud, 'fence', p_fence));

  v_response := jsonb_build_object(
    'command_id', v_command_id, 'permit_jti', v_jti,
    'operation_id', p_operation_id, 'dispatch_attempt_id', p_attempt_id,
    'fence', p_fence, 'expires_at', v_expires_at::timestamptz,
    'delivery_state', 'not_applicable', 'permit', v_permit);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The heartbeat-driven command claim.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.claim_pending_device_commands(
  p_org_id text,
  p_device_id uuid,
  p_session_id uuid,
  p_kid text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_candidate record;
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF COALESCE(p_kid, '') = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

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

  -- Dispatch every authorized action of this device's active Runs that has no dispatch row.
  -- The unreconciled-unknown predicate is filtered here so the common refusal never reaches
  -- the loop; consume re-checks it inside its own transaction anyway.
  FOR v_candidate IN
    SELECT o.id AS operation_id, o.dispatch_attempt_id AS attempt_id,
           o.request_hash, r.fence, l.id AS lease_id
    FROM work.operation o
    JOIN work.run r ON r.org_id = o.org_id AND r.id = o.run_id
    JOIN work.execution_lease l ON l.org_id = o.org_id AND l.run_id = r.id
      AND l.device_id = p_device_id AND l.session_id = p_session_id
      AND l.purpose = 'execute' AND l.state = 'active' AND l.expires_at > now()
    JOIN work.device_run_binding b ON b.org_id = o.org_id AND b.run_id = r.id
      AND b.device_id = p_device_id AND b.session_id = p_session_id AND b.state = 'active'
      AND b.binding_revision = (SELECT MAX(b2.binding_revision)
                                FROM work.device_run_binding b2
                                WHERE b2.org_id = o.org_id AND b2.run_id = r.id)
    WHERE o.org_id = p_org_id AND o.state = 'authorized' AND r.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM work.device_dispatch d
                      WHERE d.org_id = o.org_id AND d.operation_id = o.id
                        AND d.attempt_id = o.dispatch_attempt_id)
      AND NOT EXISTS (SELECT 1 FROM work.operation u
                      WHERE u.org_id = o.org_id AND u.run_id = r.id
                        AND u.state IN ('unknown', 'unresolved'))
    ORDER BY o.created_at
  LOOP
    BEGIN
      PERFORM work.consume_device_permit(p_org_id, v_candidate.operation_id,
        v_candidate.attempt_id, p_device_id, p_session_id, v_candidate.lease_id,
        v_candidate.fence, v_candidate.request_hash, p_kid);
    EXCEPTION WHEN OTHERS THEN
      -- A refused candidate stays authorized and is retried on the next heartbeat. The
      -- subtransaction rolls back its own CAS, so nothing is half-dispatched, and a domain
      -- refusal never becomes a transport failure that kills the device's session.
      NULL;
    END;
  END LOOP;

  -- Every live dispatch of THIS device and session, with the stored permit document. The
  -- gateway signs each permit under the "permit" domain and each command frame under
  -- "command"; the delivery watermark is not advanced (no command_ack frame exists, §3.1).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'command_id', d.command_id, 'run_id', o.run_id, 'operation_id', d.operation_id,
    'logical_key', o.logical_key, 'dispatch_attempt_id', d.attempt_id,
    'request_hash', d.request_hash, 'tool_schema', la.tool_schema,
    'local_payload_ref', la.local_payload_ref, 'permit', d.permit
  ) ORDER BY d.created_at), '[]'::jsonb) INTO v_result
  FROM work.device_dispatch d
  JOIN work.operation o ON o.org_id = d.org_id AND o.id = d.operation_id
  JOIN work.local_action la ON la.org_id = d.org_id AND la.operation_id = d.operation_id
    AND la.attempt_id = d.attempt_id
  WHERE d.org_id = p_org_id AND d.device_id = p_device_id AND d.session_id = p_session_id
    AND o.state = 'dispatching' AND d.expires_at > now();

  RETURN jsonb_build_object('commands', v_result);
END;
$$;

REVOKE ALL ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.claim_pending_device_commands(
  text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_pending_device_commands(
  text, uuid, uuid, text) TO work_worker;

RESET ROLE;