-- 0081: atomic local Task submission. The signed local_intent is consumed in the
-- same transaction that creates the local input metadata, Task/Run and device
-- binding. submit_task remains the single owner of the R0a Task/Run state
-- machine; its unpublished cloud start_workflow outbox row is removed before
-- commit because a device-local Run is offered through device_run_binding.
SET ROLE work_owner;

CREATE TABLE work.local_submission_intent (
  org_id text NOT NULL,
  subject_id text NOT NULL,
  client_request_id text NOT NULL,
  nonce text NOT NULL,
  proof_hash text NOT NULL,
  input_ref uuid NOT NULL,
  input_hash text NOT NULL,
  preview_hash text NOT NULL,
  target_selection_hash text NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  auth_epoch bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, nonce),
  UNIQUE (org_id, subject_id, client_request_id),
  UNIQUE (org_id, task_id),
  CONSTRAINT local_submission_intent_request_shape CHECK (client_request_id <> ''),
  CONSTRAINT local_submission_intent_nonce_shape CHECK (nonce ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT local_submission_intent_proof_hash_shape CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_submission_intent_input_hash_shape CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_submission_intent_preview_shape CHECK (preview_hash <> ''),
  CONSTRAINT local_submission_intent_target_hash_shape CHECK (target_selection_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_submission_intent_epoch_nonneg CHECK (auth_epoch >= 0),
  CONSTRAINT local_submission_intent_window CHECK (expires_at > created_at),
  CONSTRAINT local_submission_intent_consumed_window CHECK (consumed_at >= created_at),
  CONSTRAINT local_submission_intent_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT local_submission_intent_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT local_submission_intent_task_fkey
    FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  CONSTRAINT local_submission_intent_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT local_submission_intent_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.local_submission_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.local_submission_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.local_submission_intent
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.local_submission_intent_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'local_submission_intent_immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER local_submission_intent_guard BEFORE UPDATE ON work.local_submission_intent
  FOR EACH ROW EXECUTE FUNCTION work.local_submission_intent_guard();
CREATE TRIGGER local_submission_intent_no_delete BEFORE DELETE ON work.local_submission_intent
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
REVOKE ALL ON FUNCTION work.local_submission_intent_guard() FROM PUBLIC;

CREATE FUNCTION work.submit_local_task(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_client_request_id text,
  p_input_ref uuid,
  p_input_hash text,
  p_input_bytes bigint,
  p_preview_hash text,
  p_preview_expires_at timestamptz,
  p_target_selection_hash text,
  p_title text,
  p_permission_mode text,
  p_manifest jsonb,
  p_tool_allowlist text[],
  p_model_route jsonb,
  p_target_selection jsonb,
  p_local_intent jsonb
) RETURNS TABLE (task_id uuid, run_id uuid, revision bigint, binding_revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_input work.input_object%ROWTYPE;
  v_facts jsonb;
  v_grant_ids uuid[];
  v_grant_revisions text[];
  v_proof_hash text;
  v_request_hash text;
  v_snapshot_hash text;
  v_task_id uuid;
  v_run_id uuid;
  v_revision bigint;
  v_binding_revision bigint := 1;
  v_outbox_deleted integer;
  v_proof_keys text[];
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'task.submit', p_client_request_id);

  IF jsonb_typeof(p_local_intent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_target_selection) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_proof_hash := work.sha256_text(p_local_intent::text);
  v_request_hash := work.sha256_text(jsonb_build_object(
    'client_request_id', p_client_request_id,
    'input_ref', p_input_ref,
    'input_hash', p_input_hash,
    'input_bytes', p_input_bytes,
    'preview_hash', p_preview_hash,
    'target_selection_hash', p_target_selection_hash,
    'title', p_title,
    'permission_mode', p_permission_mode,
    'manifest', p_manifest,
    'target_selection', p_target_selection,
    'proof_hash', v_proof_hash
  )::text);

  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'task.submit' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF v_dedup.task_deleted OR v_dedup.task_id IS NULL THEN
      RAISE EXCEPTION 'task_deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
      SELECT t.id, r.id, t.revision, b.binding_revision
      FROM work.task t
      JOIN work.run r ON r.task_id = t.id AND r.org_id = t.org_id AND r.attempt_no = 1
      JOIN work.device_run_binding b ON b.run_id = r.id AND b.org_id = r.org_id AND b.binding_revision = 1
      WHERE t.id = v_dedup.task_id AND t.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dedup_task_missing' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;

  -- A same-key replay must survive preview/proof expiry; only a new submission reaches this guard.
  IF p_preview_expires_at <= now() THEN
    RAISE EXCEPTION 'preview_stale' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_proof_keys FROM jsonb_object_keys(p_local_intent) key;
  IF v_proof_keys IS NULL OR cardinality(v_proof_keys) <> 19
     OR NOT v_proof_keys @> ARRAY[
       'v','org_id','subject_id','auth_plane','auth_epoch','device_id','session_id','request_id',
       'input_hash','preview_hash','target_selection_hash','selected_grant_ids','grant_revisions',
       'profile_id','profile_revision','profile_hash','nonce','expires_at','signature'] THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_local_intent->>'v')::integer <> 1
     OR p_local_intent->>'org_id' <> p_org_id
     OR p_local_intent->>'subject_id' <> p_actor_subject_id
     OR p_local_intent->>'auth_plane' <> 'bearer'
     OR p_local_intent->>'auth_epoch' <> p_auth_epoch::text
     OR p_local_intent->>'request_id' <> p_client_request_id
     OR p_local_intent->>'input_hash' <> p_input_hash
     OR p_local_intent->>'preview_hash' <> p_preview_hash
     OR p_local_intent->>'target_selection_hash' <> p_target_selection_hash
     OR p_local_intent->>'device_id' <> p_target_selection->>'device_id'
     OR p_local_intent->>'session_id' <> p_target_selection->>'session_id'
     OR p_local_intent->>'profile_id' <> p_target_selection->>'profile_id'
     OR p_local_intent->>'profile_revision' <> p_target_selection->>'profile_revision'
     OR p_local_intent->>'profile_hash' <> p_target_selection->>'profile_hash'
     OR p_local_intent->>'nonce' !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_local_intent->>'signature' !~ '^[A-Za-z0-9_-]{86}$'
     OR (p_local_intent->>'expires_at')::timestamptz <= now()
     OR (p_local_intent->>'expires_at')::timestamptz > now() + interval '65 seconds' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_target_selection->>'kind' <> 'local'
     OR p_target_selection->'workspace_grants' IS NULL
     OR jsonb_typeof(p_target_selection->'workspace_grants') <> 'array' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT (value->>'grant_id')::uuid FROM jsonb_array_elements(p_target_selection->'workspace_grants') value),
         ARRAY(SELECT value->>'grant_revision' FROM jsonb_array_elements(p_target_selection->'workspace_grants') value)
    INTO v_grant_ids, v_grant_revisions;
  v_facts := work.local_preview_facts(
    p_org_id, p_actor_subject_id, p_auth_epoch,
    (p_target_selection->>'device_id')::uuid,
    (p_target_selection->>'session_id')::uuid,
    v_grant_ids, v_grant_revisions,
    p_target_selection->>'runtime_digest', p_target_selection->>'profile_id'
  );

  SELECT * INTO v_input FROM work.input_object
  WHERE id = p_input_ref AND org_id = p_org_id AND subject_id = p_actor_subject_id;
  IF FOUND THEN
    IF v_input.task_id IS NOT NULL OR v_input.status <> 'active'
       OR v_input.content_hash <> p_input_hash OR v_input.bytes <> p_input_bytes
       OR v_input.content_ref <> 'local:' || p_input_ref::text THEN
      RAISE EXCEPTION 'input_not_found' USING ERRCODE = 'P0002';
    END IF;
  ELSE
    INSERT INTO work.input_object
      (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
    VALUES
      (p_input_ref, p_org_id, p_actor_subject_id, 'local:' || p_input_ref::text,
       p_input_hash, p_input_bytes, 'application/json', 'active');
  END IF;

  v_snapshot_hash := work.sha256_text(p_manifest::text);
  SELECT * INTO v_task_id, v_run_id, v_revision
  FROM work.submit_task(
    p_org_id, p_actor_subject_id, p_client_request_id, p_input_ref, p_title,
    p_permission_mode, v_snapshot_hash, p_manifest, p_tool_allowlist, p_model_route,
    '', p_target_selection->>'runtime_digest'
  );

  UPDATE work.submission_dedup
  SET request_hash = v_request_hash
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'task.submit' AND client_request_id = p_client_request_id;

  DELETE FROM work.outbox
  WHERE org_id = p_org_id AND aggregate_type = 'run' AND aggregate_id = v_run_id
    AND payload->>'kind' = 'start_workflow' AND delivered_at IS NULL;
  GET DIAGNOSTICS v_outbox_deleted = ROW_COUNT;
  IF v_outbox_deleted <> 1 THEN
    RAISE EXCEPTION 'local_submission_outbox_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref, input_hash,
     snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision, runtime_digest,
     tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
  VALUES
    (p_org_id, v_run_id, v_binding_revision, v_task_id,
     (p_target_selection->>'device_id')::uuid,
     (p_target_selection->>'session_id')::uuid,
     p_input_ref::text, p_input_hash, 'local:' || p_input_ref::text, v_snapshot_hash,
     p_target_selection->>'profile_id', (p_target_selection->>'profile_revision')::bigint,
     p_target_selection->>'runtime_digest', p_target_selection->>'tool_manifest_hash',
     p_target_selection->>'model_version', p_target_selection->'workspace_grants',
     gen_random_uuid(), now() + interval '5 minutes', 'offered');

  -- The same atomic activation the worker path uses (0069): the Run leaves queued, the execute
  -- lease and the seq=0 baseline are written, and the binding becomes active — all in this
  -- transaction, so the pushed offer already carries a live lease to sign run_start against.
  PERFORM work.activate_device_run_binding(
    p_org_id, v_run_id, v_binding_revision, 30);

  BEGIN
    INSERT INTO work.local_submission_intent
      (org_id, subject_id, client_request_id, nonce, proof_hash, input_ref, input_hash,
       preview_hash, target_selection_hash, device_id, session_id, auth_epoch, expires_at,
       consumed_at, task_id, run_id)
    VALUES
      (p_org_id, p_actor_subject_id, p_client_request_id, p_local_intent->>'nonce', v_proof_hash,
       p_input_ref, p_input_hash, p_preview_hash, p_target_selection_hash,
       (p_target_selection->>'device_id')::uuid,
       (p_target_selection->>'session_id')::uuid,
       p_auth_epoch, (p_local_intent->>'expires_at')::timestamptz, now(), v_task_id, v_run_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END;

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'local_task.submit', 'task', v_task_id::text,
    jsonb_build_object(
      'run_id', v_run_id,
      'binding_revision', v_binding_revision,
      'device_id', p_target_selection->>'device_id',
      'session_id', p_target_selection->>'session_id',
      'input_hash', p_input_hash,
      'preview_hash', p_preview_hash,
      'target_selection_hash', p_target_selection_hash,
      'proof_hash', v_proof_hash
    )
  );
  RETURN QUERY SELECT v_task_id, v_run_id, v_revision, v_binding_revision;
END;
$$;

REVOKE ALL ON FUNCTION work.submit_local_task(
  text, text, bigint, text, uuid, text, bigint, text, timestamptz, text, text, text, jsonb, text[], jsonb, jsonb, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.submit_local_task(
  text, text, bigint, text, uuid, text, bigint, text, timestamptz, text, text, text, jsonb, text[], jsonb, jsonb, jsonb
) TO work_api;
REVOKE ALL ON TABLE work.local_submission_intent FROM PUBLIC;
REVOKE ALL ON TABLE work.local_submission_intent FROM work_api, work_worker;

RESET ROLE;
