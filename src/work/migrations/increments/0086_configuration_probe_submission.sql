-- 0086: server-owned configuration-probe submission.
--
-- A pending ExecutionProfile binding cannot use submit_local_task: that command deliberately
-- requires an already verified binding. This command creates the one bounded model_call Run whose
-- successful device_model_result can verify that pending binding. The signed local_intent remains
-- the device proof, while every executable fact is derived from the registry and probe rows.
SET ROLE work_owner;

ALTER TABLE work.task
  ADD COLUMN task_kind text NOT NULL DEFAULT 'task'
  CHECK (task_kind IN ('task', 'configuration_probe'));

-- Configuration probes intentionally have no workspace grants. Ordinary Tasks retain the original
-- non-empty grant-set authority; the exception is narrow in both purpose and cardinality.
ALTER TABLE work.device_run_binding
  DROP CONSTRAINT device_run_binding_grant_set_shape;
ALTER TABLE work.device_run_binding
  ADD CONSTRAINT device_run_binding_grant_set_shape CHECK (
    (purpose = 'configuration_probe' AND jsonb_typeof(grant_set) = 'array'
      AND jsonb_array_length(grant_set) = 0)
    OR (purpose = 'task' AND work.binding_grant_set_valid(grant_set))
  );

CREATE FUNCTION work.reject_configuration_probe_retry() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work.task t
    WHERE t.id = NEW.task_id AND t.org_id = NEW.org_id
      AND t.task_kind = 'configuration_probe' AND NEW.attempt_no <> 1
  ) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_probe_single_run
BEFORE INSERT ON work.run
FOR EACH ROW EXECUTE FUNCTION work.reject_configuration_probe_retry();

CREATE FUNCTION work.enforce_configuration_probe_operation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work.device_run_binding drb
    WHERE drb.org_id = NEW.org_id AND drb.run_id = NEW.run_id
      AND drb.purpose = 'configuration_probe'
  ) THEN
    IF NEW.kind <> 'model' OR EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.org_id = NEW.org_id AND o.run_id = NEW.run_id
    ) THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_probe_single_operation
BEFORE INSERT ON work.operation
FOR EACH ROW EXECUTE FUNCTION work.enforce_configuration_probe_operation();

CREATE FUNCTION work.enforce_configuration_probe_model_result() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work.device_run_binding drb
    WHERE drb.org_id = NEW.org_id AND drb.run_id = NEW.run_id
      AND drb.purpose = 'configuration_probe'
  ) AND EXISTS (
    SELECT 1 FROM work.device_model_result dmr
    WHERE dmr.org_id = NEW.org_id AND dmr.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_probe_single_model_result
BEFORE INSERT ON work.device_model_result
FOR EACH ROW EXECUTE FUNCTION work.enforce_configuration_probe_model_result();

CREATE FUNCTION work.guard_configuration_probe_result() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF OLD.task_id IS NOT NULL
     AND (NEW.task_id IS DISTINCT FROM OLD.task_id
          OR NEW.run_id IS DISTINCT FROM OLD.run_id) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NEW.state = 'verified' AND OLD.state <> 'verified' THEN
    IF OLD.run_id IS NULL OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NOT EXISTS (
         SELECT 1
         FROM work.device_model_result dmr
         JOIN work.device_run_binding drb
           ON drb.org_id = dmr.org_id AND drb.run_id = dmr.run_id
         WHERE dmr.org_id = NEW.org_id
           AND dmr.model_result_id = substring(NEW.receipt_ref from '^model_result:([0-9a-f-]{36})$')::uuid
           AND dmr.run_id = OLD.run_id
           AND drb.purpose = 'configuration_probe'
       ) THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_probe_result_guard
BEFORE UPDATE ON work.model_profile_probe
FOR EACH ROW EXECUTE FUNCTION work.guard_configuration_probe_result();

REVOKE ALL ON FUNCTION work.reject_configuration_probe_retry() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.enforce_configuration_probe_operation() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.enforce_configuration_probe_model_result() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.guard_configuration_probe_result() FROM PUBLIC;

-- task_summary is the common list/detail/inbox projection. Hiding probe Tasks here protects all
-- ordinary readers without adding a second, divergent filter to each HTTP query.
CREATE OR REPLACE VIEW work.task_summary
WITH (security_invoker = true) AS
SELECT
  t.org_id,
  t.id AS task_id,
  t.owner_subject_id,
  t.title,
  t.state AS task_state,
  t.permission_mode,
  t.active_run_id,
  t.latest_run_id,
  t.revision,
  t.created_at,
  t.updated_at,
  r.state AS run_state,
  r.wait_reason,
  r.terminal_reason,
  a.id AS latest_artifact_id,
  av.version_no AS latest_artifact_version,
  av.content_hash AS latest_artifact_hash,
  (t.state = 'awaiting_acceptance') AS pending_acceptance,
  COALESCE((
    SELECT count(*)
    FROM work.operation o
    WHERE o.run_id = r.id
      AND o.org_id = t.org_id
      AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown', 'unresolved')
  ), 0) AS blocking_operations,
  COALESCE((
    SELECT SUM(br.amount_tokens)
    FROM work.quota_reservation br
    JOIN work.operation o ON o.id = br.operation_id AND o.org_id = br.org_id
    WHERE o.run_id IN (
      SELECT rr.id FROM work.run rr WHERE rr.task_id = t.id AND rr.org_id = t.org_id
    )
      AND br.state IN ('held', 'unknown')
  ), 0) AS reserved_tokens,
  COALESCE((
    SELECT SUM(be.amount_tokens)
    FROM work.quota_entry be
    JOIN work.operation o ON o.id = be.operation_id AND o.org_id = be.org_id
    WHERE o.run_id IN (
      SELECT rr.id FROM work.run rr WHERE rr.task_id = t.id AND rr.org_id = t.org_id
    )
      AND be.kind IN ('settle', 'adjust')
  ), 0) AS settled_tokens,
  CASE
    WHEN t.state = 'completed' THEN 'completed'
    WHEN t.state = 'canceled' THEN 'canceled'
    WHEN t.state = 'archived' THEN 'archived'
    WHEN t.state = 'awaiting_acceptance' THEN 'awaiting_acceptance'
    WHEN r.state = 'queued' THEN 'queued'
    WHEN r.state = 'cancel_requested' THEN 'canceling'
    WHEN r.state IN ('active', 'waiting') AND r.wait_reason = 'quota' THEN 'quota_exhausted'
    WHEN r.state IN ('active', 'waiting') AND EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.run_id = r.id AND o.org_id = t.org_id AND o.state IN ('unknown', 'unresolved')
    ) THEN 'reconciling'
    WHEN r.state IN ('active', 'waiting') THEN 'running'
    WHEN r.state = 'canceled' THEN 'run_canceled'
    WHEN r.state = 'failed' THEN 'failed'
    ELSE 'open'
  END AS display_state
FROM work.task t
LEFT JOIN work.run r
  ON r.id = t.latest_run_id AND r.org_id = t.org_id
LEFT JOIN LATERAL (
  SELECT ar.id
  FROM work.artifact ar
  WHERE ar.task_id = t.id
    AND ar.org_id = t.org_id
    AND ar.state = 'published'
  ORDER BY ar.updated_at DESC
  LIMIT 1
) a ON true
LEFT JOIN LATERAL (
  SELECT v.version_no, v.content_hash
  FROM work.artifact_version v
  WHERE v.artifact_id = a.id
    AND v.org_id = t.org_id
    AND v.state = 'published'
  ORDER BY v.version_no DESC
  LIMIT 1
) av ON true
WHERE t.deleted_at IS NULL AND t.task_kind = 'task';

CREATE FUNCTION work.submit_configuration_probe(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_client_request_id text,
  p_device_id uuid,
  p_session_id uuid,
  p_binding_id uuid,
  p_probe_id uuid,
  p_preview_hash text,
  p_target_selection_hash text,
  p_local_intent jsonb
) RETURNS TABLE (task_id uuid, run_id uuid, revision bigint, binding_revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_profile work.execution_profile_revision%ROWTYPE;
  v_probe work.model_profile_probe%ROWTYPE;
  v_binding work.device_model_binding%ROWTYPE;
  v_template_hash text := work.sha256_text('device-model-probe-v1');
  v_proof_hash text;
  v_request_hash text;
  v_proof_keys text[];
  v_manifest jsonb;
  v_model_route jsonb;
  v_snapshot_hash text;
  v_input_id uuid := gen_random_uuid();
  v_task_id uuid;
  v_run_id uuid;
  v_revision bigint;
  v_binding_revision bigint := 1;
  v_outbox_deleted integer;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_device_id IS NULL OR p_session_id IS NULL OR p_binding_id IS NULL OR p_probe_id IS NULL
     OR p_preview_hash IS NULL OR p_preview_hash !~ '^[0-9a-f]{64}$'
     OR p_target_selection_hash IS NULL OR p_target_selection_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_local_intent) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id,
    'device.model_probe.submit', p_client_request_id);

  v_proof_hash := work.sha256_text(p_local_intent::text);
  v_request_hash := work.sha256_text(jsonb_build_object(
    'auth_epoch', p_auth_epoch,
    'device_id', p_device_id,
    'session_id', p_session_id,
    'binding_id', p_binding_id,
    'probe_id', p_probe_id,
    'preview_hash', p_preview_hash,
    'target_selection_hash', p_target_selection_hash,
    'proof_hash', v_proof_hash
  )::text);

  -- Replay precedes proof/probe expiry so an accepted submission remains idempotent after its
  -- short-lived proof and preview have aged out.
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'device.model_probe.submit'
    AND client_request_id = p_client_request_id;
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
      JOIN work.device_run_binding b ON b.run_id = r.id AND b.org_id = r.org_id
        AND b.binding_revision = 1
      WHERE t.id = v_dedup.task_id AND t.org_id = p_org_id
        AND t.task_kind = 'configuration_probe';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dedup_task_missing' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_proof_keys FROM jsonb_object_keys(p_local_intent) key;
  IF v_proof_keys IS NULL OR cardinality(v_proof_keys) <> 19
     OR NOT v_proof_keys @> ARRAY[
       'v','org_id','subject_id','auth_plane','auth_epoch','device_id','session_id','request_id',
       'input_hash','preview_hash','target_selection_hash','selected_grant_ids','grant_revisions',
       'profile_id','profile_revision','profile_hash','nonce','expires_at','signature'] THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_local_intent->>'v') IS DISTINCT FROM '1'
     OR p_local_intent->>'org_id' IS DISTINCT FROM p_org_id
     OR p_local_intent->>'subject_id' IS DISTINCT FROM p_actor_subject_id
     OR p_local_intent->>'auth_plane' IS DISTINCT FROM 'bearer'
     OR p_local_intent->>'auth_epoch' IS DISTINCT FROM p_auth_epoch::text
     OR p_local_intent->>'device_id' IS DISTINCT FROM p_device_id::text
     OR p_local_intent->>'session_id' IS DISTINCT FROM p_session_id::text
     OR p_local_intent->>'request_id' IS DISTINCT FROM p_client_request_id
     OR p_local_intent->>'input_hash' IS DISTINCT FROM v_template_hash
     OR p_local_intent->>'preview_hash' IS DISTINCT FROM p_preview_hash
     OR p_local_intent->>'target_selection_hash' IS DISTINCT FROM p_target_selection_hash
     OR jsonb_typeof(p_local_intent->'selected_grant_ids') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_local_intent->'grant_revisions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_local_intent->'selected_grant_ids') <> 0
     OR jsonb_array_length(p_local_intent->'grant_revisions') <> 0
     OR p_local_intent->>'profile_id' IS NULL OR p_local_intent->>'profile_id' = ''
     OR p_local_intent->>'profile_revision' !~ '^[1-9][0-9]*$'
     OR p_local_intent->>'profile_hash' !~ '^[0-9a-f]{64}$'
     OR p_local_intent->>'nonce' !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_local_intent->>'signature' !~ '^[A-Za-z0-9_-]{86}$'
     OR (p_local_intent->>'expires_at')::timestamptz <= now()
     OR (p_local_intent->>'expires_at')::timestamptz > now() + interval '65 seconds' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- Fixed authority order: org, member, device, session, profile, probe, binding. The probe is
  -- locked before its binding to serialize with record_execution_profile_probe.
  PERFORM 1 FROM work.org
  WHERE id = p_org_id AND status = 'active' AND execution_enabled
    AND NOT operator_suspended FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM work.member
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND status = 'active' AND work_seat AND role <> 'viewer' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM work.device
  WHERE org_id = p_org_id AND id = p_device_id
    AND owner_subject_id = p_actor_subject_id AND status = 'active'
    AND auth_plane = 'bearer' AND auth_epoch = p_auth_epoch FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM work.device_session
  WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id
    AND owner_subject_id = p_actor_subject_id AND state = 'active'
    AND expires_at > now() AND auth_plane = 'bearer'
    AND auth_epoch = p_auth_epoch FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_profile FROM work.execution_profile_revision ep
  WHERE ep.org_id = p_org_id AND ep.profile_id = p_local_intent->>'profile_id'
    AND ep.revision = (p_local_intent->>'profile_revision')::bigint FOR SHARE;
  IF NOT FOUND OR v_profile.status <> 'active' OR v_profile.kind <> 'device_local'
     OR v_profile.content_hash IS DISTINCT FROM p_local_intent->>'profile_hash'
     OR v_profile.max_output_tokens < 16 THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.device_session
  WHERE org_id = p_org_id AND id = p_session_id
    AND profile_id = v_profile.profile_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_probe FROM work.model_profile_probe
  WHERE org_id = p_org_id AND probe_id = p_probe_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_binding FROM work.device_model_binding
  WHERE org_id = p_org_id AND id = p_binding_id FOR UPDATE;
  IF NOT FOUND OR v_binding.id <> v_probe.binding_id
     OR v_binding.device_id <> p_device_id OR v_binding.session_id <> p_session_id
     OR v_binding.profile_id <> v_profile.profile_id
     OR v_binding.profile_revision <> v_profile.revision
     OR v_binding.profile_hash <> v_profile.content_hash
     OR v_probe.profile_id <> v_profile.profile_id
     OR v_probe.profile_revision <> v_profile.revision
     OR v_probe.profile_hash <> v_profile.content_hash
     OR v_probe.candidate_hash <> v_binding.binding_hash THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_binding.status <> 'pending_probe'
     OR v_probe.state <> 'queued'
     OR v_probe.task_id IS NOT NULL OR v_probe.run_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_probe.preview_hash <> p_preview_hash OR v_probe.expires_at <= now() THEN
    RAISE EXCEPTION 'preview_stale' USING ERRCODE = 'P0001';
  END IF;

  v_manifest := jsonb_build_object(
    'kind', 'configuration_probe',
    'probe_id', p_probe_id,
    'binding_id', p_binding_id,
    'template_hash', v_template_hash,
    'preview_hash', p_preview_hash
  );
  v_model_route := jsonb_build_object('provider', 'device_local', 'model', v_profile.model);
  v_snapshot_hash := work.sha256_text(v_manifest::text);

  INSERT INTO work.input_object
    (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
  VALUES
    (v_input_id, p_org_id, p_actor_subject_id, 'probe:' || p_probe_id::text,
     v_template_hash, octet_length('device-model-probe-v1'), 'application/json', 'active');

  SELECT * INTO v_task_id, v_run_id, v_revision
  FROM work.submit_task(
    p_org_id, p_actor_subject_id, p_client_request_id, v_input_id, 'configuration probe',
    'ask_each', v_snapshot_hash, v_manifest, ARRAY['model_call']::text[], v_model_route,
    '', v_profile.runtime_digest
  );
  UPDATE work.task SET task_kind = 'configuration_probe'
  WHERE org_id = p_org_id AND id = v_task_id;

  -- submit_task owns the Task/Run locks; keep the same executable profile under lock through the
  -- binding write. The probe/binding rows are already locked in the authority order above.
  PERFORM 1 FROM work.execution_profile_revision ep
  WHERE ep.org_id = p_org_id AND ep.profile_id = v_profile.profile_id
    AND ep.revision = v_profile.revision AND ep.status = 'active' FOR SHARE;

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
     tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state, purpose)
  VALUES
    (p_org_id, v_run_id, v_binding_revision, v_task_id, p_device_id, p_session_id,
     v_input_id::text, v_template_hash, 'probe:' || p_probe_id::text, v_snapshot_hash,
     v_profile.profile_id, v_profile.revision, v_profile.runtime_digest,
     v_profile.tool_manifest_hash, v_profile.model, '[]'::jsonb,
     gen_random_uuid(), now() + interval '5 minutes', 'offered', 'configuration_probe');

  PERFORM work.activate_device_run_binding(p_org_id, v_run_id, v_binding_revision, 30);

  BEGIN
    INSERT INTO work.local_submission_intent
      (org_id, subject_id, client_request_id, nonce, proof_hash, input_ref, input_hash,
       preview_hash, target_selection_hash, device_id, session_id, auth_epoch, expires_at,
       consumed_at, task_id, run_id)
    VALUES
      (p_org_id, p_actor_subject_id, p_client_request_id, p_local_intent->>'nonce', v_proof_hash,
       v_input_id, v_template_hash, p_preview_hash, p_target_selection_hash,
       p_device_id, p_session_id, p_auth_epoch, (p_local_intent->>'expires_at')::timestamptz,
       now(), v_task_id, v_run_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END;

  UPDATE work.model_profile_probe
  SET task_id = v_task_id, run_id = v_run_id, state = 'running', updated_at = now()
  WHERE org_id = p_org_id AND probe_id = p_probe_id;

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id,
     result_state, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'device.model_probe.submit', p_client_request_id,
     v_request_hash, v_task_id, 'accepted',
     jsonb_build_object('task_id', v_task_id, 'run_id', v_run_id,
       'revision', v_revision, 'binding_revision', v_binding_revision)::text);

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'configuration_probe.submit', 'task', v_task_id::text,
    jsonb_build_object(
      'run_id', v_run_id,
      'binding_revision', v_binding_revision,
      'binding_id', p_binding_id,
      'probe_id', p_probe_id,
      'device_id', p_device_id,
      'session_id', p_session_id,
      'input_hash', v_template_hash,
      'preview_hash', p_preview_hash,
      'target_selection_hash', p_target_selection_hash,
      'proof_hash', v_proof_hash
    )
  );
  RETURN QUERY SELECT v_task_id, v_run_id, v_revision, v_binding_revision;
END;
$$;

REVOKE ALL ON FUNCTION work.submit_configuration_probe(
  text, text, bigint, text, uuid, uuid, uuid, uuid, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.submit_configuration_probe(
  text, text, bigint, text, uuid, uuid, uuid, uuid, text, text, jsonb
) TO work_api;

RESET ROLE;
