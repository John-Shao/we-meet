-- 0075: ApprovalDecisionProof carries a real ES256 signature and exposes its owner-scoped device key.
-- 0042 shape-checked a sha256: placeholder; the API now verifies the base64url R||S signature
-- under the independent approval_decision_proof frame domain before calling the domain command.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.approval_decision_proof_valid(p_decision jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_uuid uuid;
  v_bigint bigint;
  v_ts timestamptz;
  v_scope jsonb;
  v_expiry jsonb;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_decision)) <> 20
     OR NOT p_decision ?& ARRAY[
       'v', 'org_id', 'subject_id', 'auth_plane', 'auth_epoch', 'device_id', 'session_id',
       'approval_id', 'operation_id', 'params_hash', 'expected_revision', 'decision',
       'remember_readonly', 'readonly_scope', 'readonly_expires_at', 'policy_epoch',
       'access_epoch', 'nonce', 'expires_at', 'signature']
     OR p_decision -> 'v' <> '1'::jsonb
     OR jsonb_typeof(p_decision -> 'remember_readonly') <> 'boolean'
     OR p_decision ->> 'auth_plane' IS DISTINCT FROM 'bearer'
     OR p_decision ->> 'decision' NOT IN ('approved', 'rejected')
     OR COALESCE(p_decision ->> 'params_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_decision ->> 'expected_revision', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_decision ->> 'policy_epoch', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_decision ->> 'access_epoch', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_decision ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR COALESCE(p_decision ->> 'expires_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
     OR COALESCE(p_decision ->> 'signature', '') !~ '^[A-Za-z0-9_-]{86}$'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_decision) k
                 WHERE k NOT IN ('v', 'remember_readonly', 'readonly_scope', 'readonly_expires_at')
                   AND jsonb_typeof(p_decision -> k) <> 'string') THEN
    RETURN false;
  END IF;
  v_scope := p_decision -> 'readonly_scope';
  v_expiry := p_decision -> 'readonly_expires_at';
  IF jsonb_typeof(v_scope) NOT IN ('null', 'object')
     OR (jsonb_typeof(v_scope) = 'object' AND (
          (SELECT count(*) FROM jsonb_object_keys(v_scope)) <> 4
          OR NOT v_scope ?& ARRAY['tool_set', 'resource_selector_hash', 'grant_id', 'grant_revision']
          OR jsonb_typeof(v_scope -> 'tool_set') <> 'array'))
     OR (v_expiry IS NOT NULL AND jsonb_typeof(v_expiry) <> 'null'
         AND jsonb_typeof(v_expiry) <> 'string') THEN
    RETURN false;
  END IF;
  IF (p_decision ->> 'decision') = 'rejected' AND (p_decision ->> 'remember_readonly')::boolean THEN
    RETURN false;
  END IF;
  IF NOT (p_decision ->> 'remember_readonly')::boolean
     AND (jsonb_typeof(v_scope) <> 'null' OR jsonb_typeof(v_expiry) <> 'null') THEN
    RETURN false;
  END IF;
  IF (p_decision ->> 'remember_readonly')::boolean
     AND (jsonb_typeof(v_scope) <> 'object' OR jsonb_typeof(v_expiry) <> 'string') THEN
    RETURN false;
  END IF;
  BEGIN
    v_uuid := (p_decision ->> 'device_id')::uuid;
    v_uuid := (p_decision ->> 'session_id')::uuid;
    v_uuid := (p_decision ->> 'approval_id')::uuid;
    v_uuid := (p_decision ->> 'operation_id')::uuid;
    v_bigint := (p_decision ->> 'expected_revision')::bigint;
    v_bigint := (p_decision ->> 'policy_epoch')::bigint;
    v_bigint := (p_decision ->> 'access_epoch')::bigint;
    v_ts := (p_decision ->> 'expires_at')::timestamptz;
    IF jsonb_typeof(v_expiry) = 'string' THEN
      v_ts := (p_decision ->> 'readonly_expires_at')::timestamptz;
    END IF;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN v_uuid IS NOT NULL AND v_bigint IS NOT NULL AND v_ts IS NOT NULL;
END;
$$;

CREATE FUNCTION work.approval_decision_signing_key(
  p_org_id text,
  p_actor_subject_id text,
  p_approval_id uuid,
  p_operation_id uuid,
  p_session_id uuid,
  p_device_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_jwk jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  SELECT d.public_key_jwk INTO v_jwk
  FROM work.approval a
  JOIN work.approval_operation ao ON ao.org_id = a.org_id AND ao.approval_id = a.id
  JOIN work.operation o ON o.org_id = ao.org_id AND o.id = ao.operation_id
  JOIN work.run r ON r.org_id = o.org_id AND r.id = o.run_id
  JOIN work.task t ON t.org_id = r.org_id AND t.id = r.task_id
  JOIN work.device_session s ON s.org_id = p_org_id AND s.id = p_session_id
  JOIN work.device d ON d.org_id = s.org_id AND d.id = s.device_id
  WHERE a.org_id = p_org_id AND a.id = p_approval_id
    AND o.id = p_operation_id AND s.device_id = p_device_id
    AND t.owner_subject_id = p_actor_subject_id
    AND s.owner_subject_id = p_actor_subject_id AND d.owner_subject_id = p_actor_subject_id
    AND s.state = 'active' AND s.expires_at > now() AND d.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_jwk;
END;
$$;

CREATE OR REPLACE FUNCTION work.decide_local_approval(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_approval_id uuid,
  p_client_request_id text,
  p_decision jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_approval work.approval%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_action work.local_action%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_receipt jsonb;
  v_request_hash text;
  v_scope jsonb;
  v_decision text;
  v_remember boolean;
  v_expires timestamptz;
  v_grant_id uuid;
  v_response jsonb;
  v_existing_decision work.approval_decision%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'approval.decide',
    p_client_request_id);

  IF NOT work.approval_decision_proof_valid(p_decision) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_request_hash := work.sha256_text('approval.decide|' || p_approval_id::text
    || '|' || p_actor_subject_id || '|' || COALESCE(p_decision::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'approval.decide'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  v_decision := p_decision ->> 'decision';
  IF v_decision NOT IN ('approved', 'rejected')
     OR COALESCE(p_decision ->> 'params_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_decision ->> 'signature', '') !~ '^[A-Za-z0-9_-]{86}$'
     OR COALESCE(p_decision ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR COALESCE(p_decision ->> 'expected_revision', '') !~ '^[0-9]+$'
     OR COALESCE(p_decision ->> 'policy_epoch', '') !~ '^[0-9]+$'
     OR COALESCE(p_decision ->> 'access_epoch', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_remember := COALESCE((p_decision ->> 'remember_readonly')::boolean, false);
  v_scope := p_decision -> 'readonly_scope';
  IF v_decision = 'rejected' AND v_remember THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NOT v_remember AND (v_scope IS NOT NULL AND jsonb_typeof(v_scope) <> 'null'
     OR (p_decision ->> 'readonly_expires_at') IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_remember AND (v_scope IS NULL OR jsonb_typeof(v_scope) <> 'object'
     OR (p_decision ->> 'readonly_expires_at') IS NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Every scalar the caller sent must equal the signed copy inside the proof.
  IF (p_decision ->> 'org_id') IS DISTINCT FROM p_org_id
     OR (p_decision ->> 'subject_id') IS DISTINCT FROM p_actor_subject_id
     OR (p_decision ->> 'auth_plane') IS DISTINCT FROM p_auth_plane
     OR (p_decision ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch
     OR (p_decision ->> 'approval_id') IS DISTINCT FROM p_approval_id::text THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT o.id, o.run_id INTO v_operation.id, v_operation.run_id
  FROM work.approval_operation ao
  JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
  WHERE ao.approval_id = p_approval_id AND ao.org_id = p_org_id;
  IF v_operation.id IS NULL THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = v_operation.run_id FOR UPDATE;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  IF v_task.deleted_at IS NOT NULL
     OR v_task.owner_subject_id <> p_actor_subject_id
     OR NOT EXISTS (
       SELECT 1 FROM work.member m
       WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
         AND m.status = 'active' AND m.role <> 'viewer') THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = v_operation.id FOR UPDATE;
  SELECT * INTO v_action FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = v_operation.id
    ORDER BY created_at LIMIT 1;
  IF (p_decision ->> 'operation_id') IS DISTINCT FROM v_operation.id::text THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- The current execution authority: the device session that carries this plane/epoch.
  SELECT * INTO v_session FROM work.device_session s
    WHERE s.org_id = p_org_id AND s.id = (p_decision ->> 'session_id')::uuid;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_session.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM p_auth_epoch
     OR v_session.device_id::text IS DISTINCT FROM (p_decision ->> 'device_id')
     OR v_session.owner_subject_id IS DISTINCT FROM p_actor_subject_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_approval FROM work.approval
    WHERE org_id = p_org_id AND id = p_approval_id FOR UPDATE;
  IF v_approval.status <> 'pending' THEN
    -- A replay of the same client_request_id was already answered by the audit receipt
    -- above; a different request against an already-decided approval is not pending.
    RAISE EXCEPTION 'approval_not_pending' USING ERRCODE = 'P0001';
  END IF;
  IF v_approval.revision IS DISTINCT FROM
       (p_decision ->> 'expected_revision')::bigint
     OR v_approval.params_hash IS DISTINCT FROM (p_decision ->> 'params_hash')
     OR v_approval.expires_at <= now()
     OR (p_decision ->> 'expires_at')::timestamptz <= now() THEN
    RAISE EXCEPTION 'approval_stale_or_expired' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;
  IF (p_decision ->> 'policy_epoch')::bigint IS DISTINCT FROM v_policy.effective_epoch
     OR (p_decision ->> 'access_epoch')::bigint IS DISTINCT FROM
        v_run.admission_access_epoch THEN
    RAISE EXCEPTION 'approval_stale_or_expired' USING ERRCODE = 'P0001';
  END IF;
  -- The nonce is single-use across the whole organization, not just this approval.
  IF EXISTS (SELECT 1 FROM work.approval_decision
             WHERE org_id = p_org_id AND nonce = p_decision ->> 'nonce') THEN
    RAISE EXCEPTION 'approval_nonce_reused' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.approval
    SET status = v_decision, revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_approval_id;
  INSERT INTO work.approval_decision
    (approval_id, org_id, decision, actor_subject_id, params_hash, policy_epoch, nonce)
  VALUES
    (p_approval_id, p_org_id, v_decision, p_actor_subject_id,
     p_decision ->> 'params_hash', v_approval.policy_epoch, p_decision ->> 'nonce');

  v_grant_id := NULL;
  IF v_decision = 'approved' THEN
    UPDATE work.operation
      SET state = 'authorized', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_operation.id;
    IF v_run.state = 'waiting' AND v_run.wait_reason = 'approval' THEN
      PERFORM work.resume_run(p_org_id, v_run.id);
    END IF;
    IF v_remember THEN
      -- Remembering is only ever readonly: the tool_set closed set excludes
      -- artifact.write and every model action, so a write can never be remembered.
      IF v_action.action_kind NOT IN ('workspace.list', 'workspace.read',
                                      'workspace.search') THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_grant FROM work.workspace_grant
        WHERE org_id = p_org_id AND id = v_action.grant_id;
      -- The remembered scope must be exactly the scope that was approved: same grant,
      -- same revision, same selector, and a tool_set that contains this action and
      -- nothing outside the three readonly kinds. A proof may not widen it.
      IF jsonb_typeof(v_scope -> 'tool_set') <> 'array'
         OR jsonb_array_length(v_scope -> 'tool_set') = 0
         OR NOT work.text_array_closed_unique(
              ARRAY(SELECT jsonb_array_elements_text(v_scope -> 'tool_set')),
              ARRAY['workspace.list', 'workspace.read', 'workspace.search'])
         OR NOT (v_action.action_kind = ANY(
              ARRAY(SELECT jsonb_array_elements_text(v_scope -> 'tool_set'))))
         OR COALESCE(v_scope ->> 'resource_selector_hash', '') !~ '^[0-9a-f]{64}$'
         OR (v_scope ->> 'resource_selector_hash') IS DISTINCT FROM
            v_action.resource_selector_hash
         OR (v_scope ->> 'grant_id') IS DISTINCT FROM v_action.grant_id::text
         OR COALESCE(v_scope ->> 'grant_revision', '') !~ '^[0-9]+$'
         OR (v_scope ->> 'grant_revision')::bigint IS DISTINCT FROM
            v_action.grant_revision THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
      END IF;
      v_expires := LEAST(now() + interval '24 hours', v_grant.expires_at,
        (p_decision ->> 'readonly_expires_at')::timestamptz);
      IF v_expires <= now() THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
      END IF;
      INSERT INTO work.readonly_approval_grant
        (org_id, owner_subject_id, run_id, device_id, workspace_grant_id,
         grant_revision, tool_set, resource_selector_hash, policy_epoch, access_epoch,
         approval_id, expires_at, status)
      VALUES
        (p_org_id, p_actor_subject_id, v_run.id, v_session.device_id, v_grant.id,
         v_grant.grant_revision,
         ARRAY(SELECT jsonb_array_elements_text(v_scope -> 'tool_set')),
         v_scope ->> 'resource_selector_hash', v_policy.effective_epoch,
         v_run.admission_access_epoch, p_approval_id, v_expires, 'active')
      RETURNING id INTO v_grant_id;
    END IF;
  ELSE
    UPDATE work.operation
      SET state = 'canceled', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_operation.id;
    -- Rejecting one action ends this Run (control §5). Other undispatched actions are
    -- cancelled by the same terminal path; dispatched ones stay for reconciliation.
    PERFORM work.finish_local_run_state(p_org_id, v_run.id, 'canceled',
      'approval_rejected');
  END IF;

  PERFORM work.append_task_event(p_org_id, v_task.id, 'approval.decided',
    jsonb_build_object('approval_id', p_approval_id,
      'operation_id', v_operation.id, 'decision', v_decision,
      'readonly_grant_id', v_grant_id));
  v_response := jsonb_build_object('approval_id', p_approval_id,
    'operation_id', v_operation.id, 'decision', v_decision,
    'approval_revision', v_approval.revision + 1,
    'readonly_grant_id', v_grant_id, 'run_id', v_run.id);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'approval.decide',
    'approval', p_approval_id::text,
    jsonb_build_object('request_id', p_client_request_id,
      'request_hash', v_request_hash, 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.approval_decision_proof_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.approval_decision_signing_key(text, text, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.approval_decision_signing_key(text, text, uuid, uuid, uuid, uuid) TO work_api;

RESET ROLE;
