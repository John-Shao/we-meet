-- 0074: verify GrantSuccessionProof freshness/session shape and expose its device key.
SET ROLE work_owner;

CREATE FUNCTION work.grant_succession_proof_valid(p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_uuid uuid;
  v_bigint bigint;
  v_ts timestamptz;
BEGIN
  IF p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_proof)) <> 10
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_proof) k
                 WHERE jsonb_typeof(p_proof -> k) <> 'string')
     OR NOT p_proof ?& ARRAY[
       'old_grant_id', 'new_grant_id', 'root_identity_hash', 'run_id', 'session_id',
       'auth_plane', 'auth_epoch', 'nonce', 'expires_at', 'signature']::text[]
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM 'bearer'
     OR COALESCE(p_proof ->> 'root_identity_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_proof ->> 'auth_epoch', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_proof ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR COALESCE(p_proof ->> 'expires_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
     OR COALESCE(p_proof ->> 'signature', '') !~ '^[A-Za-z0-9_-]{86}$' THEN
    RETURN false;
  END IF;
  BEGIN
    v_uuid := (p_proof ->> 'old_grant_id')::uuid;
    v_uuid := (p_proof ->> 'new_grant_id')::uuid;
    v_uuid := (p_proof ->> 'run_id')::uuid;
    v_uuid := (p_proof ->> 'session_id')::uuid;
    v_bigint := (p_proof ->> 'auth_epoch')::bigint;
    v_ts := (p_proof ->> 'expires_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN v_uuid IS NOT NULL AND v_bigint IS NOT NULL AND v_bigint >= 0 AND v_ts IS NOT NULL;
END;
$$;

CREATE FUNCTION work.workspace_rebind_signing_key(
  p_org_id text,
  p_actor_subject_id text,
  p_run_id uuid,
  p_new_grant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
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
  FROM work.run r
  JOIN work.task t ON t.org_id = r.org_id AND t.id = r.task_id
  JOIN work.workspace_grant g ON g.org_id = r.org_id AND g.id = p_new_grant_id
  JOIN work.device d ON d.org_id = g.org_id AND d.id = g.device_id
  WHERE r.org_id = p_org_id AND r.id = p_run_id
    AND t.owner_subject_id = p_actor_subject_id
    AND g.owner_subject_id = p_actor_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_jwk;
END;
$$;

REVOKE ALL ON FUNCTION work.grant_succession_proof_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.workspace_rebind_signing_key(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.workspace_rebind_signing_key(text, text, uuid, uuid) TO work_api;

CREATE OR REPLACE FUNCTION work.rebind_run_workspace(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_run_id uuid,
  p_client_request_id text,
  p_old_grant_id uuid,
  p_new_grant_id uuid,
  p_proof jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_old work.workspace_grant%ROWTYPE;
  v_new work.workspace_grant%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_activation jsonb;
  v_revision bigint;
  v_nonce uuid;
  v_grant_set jsonb;
  v_invalidated int;
  v_cp_seq bigint;
  v_cp_hash text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('run.workspace_rebind|' || p_run_id::text
    || '|' || p_old_grant_id::text || '|' || p_new_grant_id::text
    || '|' || COALESCE(p_proof::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'run.workspace_rebind'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_old_grant_id IS NULL OR p_new_grant_id IS NULL
     OR p_old_grant_id = p_new_grant_id
     OR NOT work.grant_succession_proof_valid(p_proof) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_proof ->> 'old_grant_id')::uuid IS DISTINCT FROM p_old_grant_id
     OR (p_proof ->> 'new_grant_id')::uuid IS DISTINCT FROM p_new_grant_id
     OR (p_proof ->> 'run_id')::uuid IS DISTINCT FROM p_run_id
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM p_auth_plane
     OR (p_proof ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_proof ->> 'expires_at')::timestamptz <= now()
     OR (p_proof ->> 'expires_at')::timestamptz > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM work.consumed_possession_nonce
             WHERE org_id = p_org_id AND nonce = (p_proof ->> 'nonce')) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce)
    VALUES (p_org_id, 'workspace_rebind', p_proof ->> 'nonce');

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF v_task.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_task.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state NOT IN ('waiting', 'active')
     OR (v_run.state = 'waiting' AND v_run.wait_reason IS DISTINCT FROM 'input') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
    ORDER BY binding_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_binding.grant_set) e
                  WHERE (e ->> 'grant_id')::uuid = p_old_grant_id) THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_old_grant_id FOR UPDATE;
  SELECT * INTO v_new FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_new_grant_id FOR UPDATE;
  IF NOT FOUND OR v_new.state <> 'active' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_new.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_new.device_id IS DISTINCT FROM v_binding.device_id THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF v_new.root_identity_hash IS DISTINCT FROM v_old.root_identity_hash
     OR v_new.root_identity_hash IS DISTINCT FROM (p_proof ->> 'root_identity_hash') THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF (p_proof ->> 'session_id')::uuid IS DISTINCT FROM v_new.session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = v_new.session_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> v_new.device_id
     OR v_session.state <> 'active' OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT checkpoint_seq, checkpoint_hash INTO v_cp_seq, v_cp_hash
  FROM work.device_checkpoint
  WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded'
  ORDER BY checkpoint_seq DESC LIMIT 1;

  v_revision := v_binding.binding_revision + 1;
  v_nonce := gen_random_uuid();
  SELECT jsonb_agg(
           CASE WHEN (e ->> 'grant_id')::uuid = p_old_grant_id
                THEN jsonb_build_object('grant_id', p_new_grant_id,
                                        'grant_revision', v_new.grant_revision)
                ELSE e END)
    INTO v_grant_set
    FROM jsonb_array_elements(v_binding.grant_set) e;

  INSERT INTO work.workspace_grant_succession
    (org_id, run_id, old_grant_id, new_grant_id, proof_hash, binding_revision,
     client_request_id, request_hash)
  VALUES
    (p_org_id, p_run_id, p_old_grant_id, p_new_grant_id,
     work.sha256_text(p_proof::text), v_revision, p_client_request_id, v_request_hash);

  UPDATE work.workspace_grant
    SET state = 'succeeded', succeeded_by = p_new_grant_id, updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_old_grant_id AND state = 'active';

  UPDATE work.readonly_approval_grant
    SET status = 'invalidated', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND workspace_grant_id = p_old_grant_id AND status = 'active';
  GET DIAGNOSTICS v_invalidated = ROW_COUNT;

  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
     input_hash, snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision,
     runtime_digest, tool_manifest_hash, model_version, grant_set,
     expected_checkpoint_seq, expected_checkpoint_hash, start_nonce, offer_expiry, state)
  VALUES
    (p_org_id, p_run_id, v_revision, v_binding.task_id, v_binding.device_id,
     v_new.session_id, v_binding.input_ref, v_binding.input_hash,
     v_binding.snapshot_descriptor_ref, v_binding.snapshot_hash, v_binding.profile_id,
     v_binding.profile_revision, v_binding.runtime_digest, v_binding.tool_manifest_hash,
     v_binding.model_version, v_grant_set, v_cp_seq, v_cp_hash, v_nonce,
     now() + interval '120 seconds', 'offered');
  v_activation := work.activate_device_run_binding(
    p_org_id, p_run_id, v_revision, 30);

  UPDATE work.run
    SET control_revision = control_revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_run_id;

  v_response := jsonb_build_object('run_id', p_run_id, 'old_grant_id', p_old_grant_id,
    'new_grant_id', p_new_grant_id, 'binding_revision', v_revision,
    'expected_checkpoint_seq', v_cp_seq, 'expected_checkpoint_hash', v_cp_hash,
    'offer_expiry', now() + interval '120 seconds', 'state', 'active',
    'checkpoint_seq', v_activation -> 'checkpoint_seq',
    'checkpoint_hash', v_activation ->> 'checkpoint_hash',
    'invalidated_readonly_grants', v_invalidated);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'run.workspace_rebind',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'nonce', p_proof ->> 'nonce', 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) TO work_api;

RESET ROLE;
