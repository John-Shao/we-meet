-- 0089: refresh an expired pending device-model probe without replacing its binding.
SET ROLE work_owner;

CREATE FUNCTION work.refresh_device_model_probe_preview(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_binding_id uuid,
  p_client_request_id text,
  p_binding_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_profile work.execution_profile_revision%ROWTYPE;
  v_binding work.device_model_binding%ROWTYPE;
  v_probe work.model_profile_probe%ROWTYPE;
  v_probe_id uuid;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_template_hash text := work.sha256_text('device-model-probe-v1');
  v_preview_hash text;
  v_request_hash text;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF NOT EXISTS (
    SELECT 1 FROM work.org
    WHERE id = p_org_id AND status = 'active' AND execution_enabled
      AND NOT operator_suspended
  ) THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id,
    'device.model_probe.refresh', p_client_request_id);

  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.work_seat AND m.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = '42501';
  END IF;

  v_request_hash := work.sha256_text(jsonb_build_object(
    'auth_epoch', p_auth_epoch, 'device_id', p_device_id, 'session_id', p_session_id,
    'binding_id', p_binding_id, 'binding_revision', p_binding_revision
  )::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'device.model_probe.refresh'
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_dedup.result_ref::jsonb;
  END IF;

  SELECT * INTO v_device FROM work.device
  WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_device.status <> 'active'
     OR v_device.owner_subject_id <> p_actor_subject_id
     OR v_device.auth_plane <> 'bearer'
     OR v_device.auth_epoch <> p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
  WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= now()
     OR v_session.owner_subject_id <> p_actor_subject_id
     OR v_session.auth_plane <> 'bearer'
     OR v_session.auth_epoch <> p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_model_binding
  WHERE org_id = p_org_id AND id = p_binding_id FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id <> p_device_id
     OR v_binding.session_id <> p_session_id
     OR v_binding.revision <> p_binding_revision
     OR v_binding.status <> 'pending_probe'
     OR v_session.profile_id <> v_binding.profile_id THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_profile FROM work.execution_profile_revision
  WHERE org_id = p_org_id AND profile_id = v_binding.profile_id
    AND revision = v_binding.profile_revision FOR SHARE;
  IF NOT FOUND OR v_profile.status <> 'active'
     OR v_profile.content_hash <> v_binding.profile_hash
     OR v_profile.kind <> 'device_local' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_probe FROM work.model_profile_probe
  WHERE org_id = p_org_id AND binding_id = p_binding_id
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_probe.state <> 'queued' OR v_probe.expires_at > now()
     OR v_probe.task_id IS NOT NULL OR v_probe.run_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_probe_id := gen_random_uuid();
  v_created_at := now();
  v_expires_at := v_created_at + interval '60 seconds';
  v_preview_hash := work.sha256_text(jsonb_build_object(
    'org_id', p_org_id,
    'device_id', p_device_id,
    'session_id', p_session_id,
    'profile_id', v_binding.profile_id,
    'profile_revision', v_binding.profile_revision,
    'profile_hash', v_binding.profile_hash,
    'binding_hash', v_binding.binding_hash,
    'probe_id', v_probe_id,
    'template_hash', v_template_hash,
    'max_output_tokens', 16,
    'expires_at', v_expires_at
  )::text);

  INSERT INTO work.model_profile_probe
    (org_id, probe_id, binding_id, profile_id, profile_revision, profile_hash,
     candidate_hash, preview_hash, expires_at, state, created_at, updated_at)
  VALUES
    (p_org_id, v_probe_id, p_binding_id, v_binding.profile_id,
     v_binding.profile_revision, v_binding.profile_hash, v_binding.binding_hash,
     v_preview_hash, v_expires_at, 'queued', v_created_at, v_created_at);

  v_response := jsonb_build_object(
    'binding_id', p_binding_id,
    'binding_revision', v_binding.revision,
    'probe_preview', jsonb_build_object(
      'probe_id', v_probe_id,
      'preview_hash', v_preview_hash,
      'template_hash', v_template_hash,
      'max_output_tokens', 16,
      'expires_at', v_expires_at
    )
  );
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'device.model_probe.refresh', p_client_request_id,
     v_request_hash, v_response::text);
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'device_model_probe.refresh', 'device_model_binding',
    p_binding_id::text,
    jsonb_build_object(
      'device_id', p_device_id, 'session_id', p_session_id,
      'old_probe_id', v_probe.probe_id, 'probe_id', v_probe_id,
      'binding_revision', v_binding.revision));
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION work.refresh_device_model_probe_preview(
  text, text, bigint, uuid, uuid, uuid, text, bigint
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.refresh_device_model_probe_preview(
  text, text, bigint, uuid, uuid, uuid, text, bigint
) TO work_api;

RESET ROLE;
