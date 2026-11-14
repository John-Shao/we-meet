-- 0045: local acceptance face (control-design §1.4 row 74, §7.1, §5; device §7.3).
--
-- M1a/M1b landed the local save path (create_local_user_artifact_version, 0043) and the
-- approval face (0042/0044), but acceptance still only had the R0a cookie-plane accept_task
-- (0002:3565), which carries no device proof. §1.4 row 74 requires a local acceptance to bind
-- a current PossessionProof(purpose=accept) on the Bearer plane, so this increment adds the
-- local command alongside accept_task rather than widening the published R0a function — the
-- same split 0043 used for create_local_user_artifact_version vs create_user_artifact_version.
--
-- Two design facts are taken from the signed text, not invented here:
--   * Acceptance reuses the TASK-level quiescence gate (active_run_id IS NULL plus
--     task_has_blocking_operation over prepared/waiting_approval/authorized/dispatching/
--     unknown/unresolved), exactly as accept_task does (0002:3619). This is deliberately NOT
--     the run-level gate finalize_local_artifact uses (§6.4 step 4 / O-18=丙, EV104): a Run may
--     finish while a sibling Run's unknown Operation still blocks adoption of the Task.
--   * The local face is version-based only. §7.1 "用户理由完成不计成果采纳" keeps reason-only
--     completion on the R0a cookie face; a PossessionProof binds artifact_id/version_id/
--     content_hash, so a reason-only request cannot carry one. acceptance_blocked_unresolvable
--     is not re-implemented here: it stays the 0021 BEFORE INSERT trigger on work.acceptance
--     (block_acceptance_when_unresolvable), which fires on the insert below.
--
-- No table privilege is granted (0024 house rule); work_api reaches the rows only through this
-- SECURITY DEFINER function. No new public error code is registered: every code raised here is
-- already produced by accept_task, create_local_user_artifact_version (0043) or the 0021
-- trigger and already has a db_exception_map entry. The proof validator is a SHAPE check
-- (closed 15-key set + field formats); real device-signature verification belongs to M3/M5,
-- exactly like user_version_proof_valid / approval_decision_proof_valid.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- The single-use possession nonce table (0043) gains the 'accept' purpose. CHECK
-- constraints cannot be CREATE OR REPLACE'd, so drop and re-add with the wider closed
-- set; the two existing purposes keep their writers (0043 user_version, 0041/0043
-- workspace_rebind). Append-only and never-swept semantics are unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE work.consumed_possession_nonce
  DROP CONSTRAINT consumed_possession_nonce_purpose_check;
ALTER TABLE work.consumed_possession_nonce
  ADD CONSTRAINT consumed_possession_nonce_purpose_check
  CHECK (purpose IN ('user_version', 'workspace_rebind', 'accept'));

-- ---------------------------------------------------------------------------
-- possession_proof_valid: the closed 15-key PossessionProof shape (control §1.3).
-- Like user_version_proof_valid (0043:261) there is NO 'signature' key — the frame is
-- signed in the HTTP header, so a payload signature would be a 16th key the closed set
-- does not have. 'v' is checked for presence only, matching the shipped commands. This
-- period the purpose closed set is just 'accept' (card E=B); restore/read_ticket/sync are
-- out of scope, so a proof carrying any other purpose is refused here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.possession_proof_valid(p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_uuid uuid;
  v_ts timestamptz;
  v_bigint bigint;
BEGIN
  IF p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_proof)) <> 15
     OR NOT p_proof ?& ARRAY[
       'v', 'org_id', 'subject_id', 'auth_plane', 'auth_epoch', 'device_id', 'session_id',
       'task_id', 'artifact_id', 'version_id', 'content_hash', 'purpose', 'request_id',
       'nonce', 'expires_at']::text[]
     OR p_proof ->> 'purpose' IS DISTINCT FROM 'accept'
     OR COALESCE(p_proof ->> 'content_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_proof ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR COALESCE(p_proof ->> 'org_id', '') = ''
     OR COALESCE(p_proof ->> 'subject_id', '') = ''
     OR COALESCE(p_proof ->> 'request_id', '') = '' THEN
    RETURN false;
  END IF;
  BEGIN
    v_uuid := (p_proof ->> 'device_id')::uuid;
    v_uuid := (p_proof ->> 'session_id')::uuid;
    v_uuid := (p_proof ->> 'task_id')::uuid;
    v_uuid := (p_proof ->> 'artifact_id')::uuid;
    v_uuid := (p_proof ->> 'version_id')::uuid;
    v_bigint := (p_proof ->> 'auth_epoch')::bigint;
    v_ts := (p_proof ->> 'expires_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_uuid IS NULL OR v_ts IS NULL OR v_bigint IS NULL OR v_bigint < 0 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- accept_local_task (control §1.4 row 74, §7.1; device §7.3).
--
-- Judgment order mirrors create_local_user_artifact_version (0043): the dedupe probe runs
-- BEFORE any proof judgment so a same-request_id replay neither re-checks expiry nor
-- consumes the nonce again; the nonce is consumed before any business write so a later
-- refusal rolls it back. The Task-level quiescence gate and the acceptance insert are
-- accept_task's (0002:3606-3651), kept verbatim in shape so the 0021 adoption trigger fires
-- on exactly the same predicate as the R0a path.
--
-- access_restriction and organization suspension stay at the API/Host layer, as in all
-- shipped commands (0040/0041/0042/0043); this increment does not start a third arrangement.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.accept_local_task(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_task_id uuid,
  p_client_request_id text,
  p_expected_revision bigint,
  p_artifact_id uuid,
  p_proof jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task work.task%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_version work.artifact_version%ROWTYPE;
  v_dedup work.submission_dedup%ROWTYPE;
  v_acceptance work.acceptance%ROWTYPE;
  v_request_hash text;
  v_version_id uuid;
  v_nonce text;
  v_acceptance_id uuid := gen_random_uuid();
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_auth_plane IS DISTINCT FROM 'bearer' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NOT work.possession_proof_valid(p_proof) OR p_artifact_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_version_id := (p_proof ->> 'version_id')::uuid;
  v_nonce := p_proof ->> 'nonce';

  -- Same idempotency domain as the R0a acceptance (0002:3583), not a new '.local' domain.
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'task.accept',
    p_client_request_id);
  v_request_hash := work.sha256_text('task.accept.local|' || p_task_id::text
    || '|' || p_expected_revision::text || '|' || p_artifact_id::text
    || '|' || p_proof::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
    WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
      AND operation_type = 'task.accept' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF v_dedup.task_deleted THEN
      RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_acceptance FROM work.acceptance
      WHERE org_id = p_org_id AND id = v_dedup.result_ref::uuid;
    RETURN jsonb_build_object(
      'acceptance_id', v_acceptance.id, 'task_id', v_acceptance.task_id,
      'artifact_id', v_acceptance.artifact_id, 'version_no', v_acceptance.version_no,
      'revision', v_acceptance.task_revision, 'replayed', true);
  END IF;

  -- Every scalar the caller sent must equal the signed copy inside the proof.
  IF p_proof ->> 'org_id' IS DISTINCT FROM p_org_id
     OR p_proof ->> 'subject_id' IS DISTINCT FROM p_actor_subject_id
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM p_auth_plane
     OR (p_proof ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch
     OR (p_proof ->> 'device_id')::uuid IS DISTINCT FROM p_device_id
     OR (p_proof ->> 'session_id')::uuid IS DISTINCT FROM p_session_id
     OR (p_proof ->> 'task_id')::uuid IS DISTINCT FROM p_task_id
     OR (p_proof ->> 'artifact_id')::uuid IS DISTINCT FROM p_artifact_id
     OR p_proof ->> 'request_id' IS DISTINCT FROM p_client_request_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id;
  IF NOT FOUND OR v_device.owner_subject_id <> p_actor_subject_id
     OR v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_session.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM p_auth_epoch
     OR v_session.device_id IS DISTINCT FROM p_device_id
     OR v_session.owner_subject_id IS DISTINCT FROM p_actor_subject_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.role <> 'viewer') THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;

  -- PossessionProof validity is 30s (control §1.3 / device §7.3), not the 60s ticket TTL.
  IF (p_proof ->> 'expires_at')::timestamptz <= now() THEN
    RAISE EXCEPTION 'local_proof_expired' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM work.consumed_possession_nonce
             WHERE org_id = p_org_id AND nonce = v_nonce) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce)
    VALUES (p_org_id, 'accept', v_nonce);

  -- Task gate, verbatim in shape from accept_task (0002:3606-3631).
  SELECT * INTO v_task FROM work.task t
    WHERE t.id = p_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND OR v_task.owner_subject_id <> p_actor_subject_id THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = v_task.revision::text;
  END IF;
  IF v_task.state <> 'awaiting_acceptance' THEN
    RAISE EXCEPTION 'task_not_acceptable' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.active_run_id IS NOT NULL OR work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;

  -- The proof names a specific published version of this Task's artifact; its content_hash
  -- must equal the version's. A version on another artifact/task, or unpublished, is not
  -- acceptable (artifact_not_published, the same code accept_task uses).
  SELECT av.* INTO v_version FROM work.artifact_version av
    JOIN work.artifact a ON a.id = av.artifact_id AND a.org_id = av.org_id
    WHERE av.version_id = v_version_id AND av.artifact_id = p_artifact_id
      AND av.org_id = p_org_id AND av.state = 'published'
      AND a.task_id = p_task_id AND a.deleted_at IS NULL AND a.state = 'published';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artifact_not_published' USING ERRCODE = 'P0001';
  END IF;
  IF v_version.content_hash IS DISTINCT FROM (p_proof ->> 'content_hash') THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.task t
    SET state = 'completed', revision = t.revision + 1, updated_at = now()
    WHERE t.id = p_task_id AND t.org_id = p_org_id;
  -- The 0021 BEFORE INSERT trigger raises acceptance_blocked_unresolvable here when the
  -- Task has an evidence_exhausted Operation; no acceptance row is written on that branch.
  INSERT INTO work.acceptance
    (id, org_id, task_id, artifact_id, version_no, actor_subject_id, task_revision, completion_reason)
  VALUES
    (v_acceptance_id, p_org_id, p_task_id, p_artifact_id, v_version.version_no,
     p_actor_subject_id, p_expected_revision + 1, NULL);
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'task.accept', p_client_request_id,
     v_request_hash, p_task_id, 'completed', v_acceptance_id::text);
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'task.accept', 'task', p_task_id::text,
    jsonb_build_object('acceptance_id', v_acceptance_id, 'basis', 'version',
      'artifact_id', p_artifact_id, 'version_no', v_version.version_no,
      'version_id', v_version_id, 'device_id', p_device_id,
      'nonce', v_nonce, 'proof_digest', work.sha256_text(p_proof::text)));
  RETURN jsonb_build_object(
    'acceptance_id', v_acceptance_id, 'task_id', p_task_id,
    'artifact_id', p_artifact_id, 'version_no', v_version.version_no,
    'revision', p_expected_revision + 1, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.possession_proof_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.accept_local_task(
  text, text, text, bigint, uuid, uuid, uuid, text, bigint, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.accept_local_task(
  text, text, text, bigint, uuid, uuid, uuid, text, bigint, uuid, jsonb) TO work_api;

RESET ROLE;