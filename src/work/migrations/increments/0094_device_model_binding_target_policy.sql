-- 0094: bind device model confirmations to approved loopback targets and listener policy.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.publish_execution_profile(p_org_id text, p_actor_subject_id text, p_client_request_id text, p_profile jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'work', 'pg_catalog'
AS $function$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_profile_id text;
  v_status text;
  v_content_hash text;
  v_revision bigint;
  v_request_hash text;
  v_response jsonb;
  v_keys text[];
  v_allowed text[] := ARRAY[
    'profile_id','kind','provider','model','api_type','residency',
    'endpoint_policy','tokenizer_id','context_tokens','max_request_bytes',
    'max_output_tokens','usage_mode','runtime_digest','tool_manifest_hash',
    'compat_profile_version','max_turns','status'
  ];
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id,
    'execution_profile.publish', p_client_request_id);

  IF p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_keys := ARRAY(SELECT jsonb_object_keys(p_profile));
  IF cardinality(v_keys) <> cardinality(v_allowed) OR NOT v_keys @> v_allowed THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_profile -> 'endpoint_policy') <> 'object'
     OR jsonb_typeof(p_profile -> 'context_tokens') <> 'number'
     OR jsonb_typeof(p_profile -> 'max_request_bytes') <> 'number'
     OR jsonb_typeof(p_profile -> 'max_output_tokens') <> 'number'
     OR jsonb_typeof(p_profile -> 'max_turns') <> 'number'
     OR (p_profile ->> 'profile_id') IS NULL
     OR jsonb_typeof(p_profile -> 'kind') <> 'string'
     OR jsonb_typeof(p_profile -> 'provider') <> 'string'
     OR jsonb_typeof(p_profile -> 'model') <> 'string'
     OR jsonb_typeof(p_profile -> 'api_type') <> 'string'
     OR jsonb_typeof(p_profile -> 'residency') <> 'string'
     OR jsonb_typeof(p_profile -> 'tokenizer_id') <> 'string'
     OR jsonb_typeof(p_profile -> 'usage_mode') <> 'string'
     OR jsonb_typeof(p_profile -> 'runtime_digest') <> 'string'
     OR jsonb_typeof(p_profile -> 'tool_manifest_hash') <> 'string'
     OR jsonb_typeof(p_profile -> 'compat_profile_version') <> 'string'
     OR jsonb_typeof(p_profile -> 'status') <> 'string' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_profile_id := p_profile ->> 'profile_id';
  v_status := p_profile ->> 'status';
  IF v_profile_id IS NULL OR length(v_profile_id) NOT BETWEEN 1 AND 128
     OR v_profile_id <> btrim(v_profile_id)
     OR (p_profile ->> 'runtime_digest') IS NULL
     OR (p_profile ->> 'runtime_digest') !~ '^[0-9a-f]{64}$'
     OR (p_profile ->> 'tool_manifest_hash') IS NULL
     OR (p_profile ->> 'tool_manifest_hash') !~ '^[0-9a-f]{64}$'
     OR (p_profile ->> 'kind') IS NULL
     OR (p_profile ->> 'kind') NOT IN ('device_local', 'org_private', 'org_remote')
     OR (p_profile ->> 'api_type') IS NULL
     OR (p_profile ->> 'api_type') NOT IN ('chat_completions', 'responses')
     OR (p_profile ->> 'usage_mode') IS NULL
     OR (p_profile ->> 'usage_mode') NOT IN ('actual', 'estimated')
     OR v_status IS NULL OR v_status NOT IN ('draft', 'active')
     OR (v_status = 'active' AND (p_profile ->> 'kind') <> 'device_local')
     OR (p_profile ->> 'provider') IS NULL OR (p_profile ->> 'provider') = ''
     OR (p_profile ->> 'model') IS NULL OR (p_profile ->> 'model') = ''
     OR (p_profile ->> 'residency') IS NULL OR (p_profile ->> 'residency') = ''
     OR (p_profile ->> 'tokenizer_id') IS NULL OR (p_profile ->> 'tokenizer_id') = ''
     OR (p_profile ->> 'compat_profile_version') IS NULL
     OR (p_profile ->> 'compat_profile_version') = ''
     OR (p_profile ->> 'context_tokens')::bigint <= 0
     OR (p_profile ->> 'max_request_bytes')::bigint <= 0
     OR (p_profile ->> 'max_output_tokens')::bigint <= 0
     OR (p_profile ->> 'max_turns')::bigint <= 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_content_hash := work.sha256_text((p_profile - 'status')::text);
  IF (p_profile ->> 'kind') = 'device_local'
     AND (p_profile -> 'endpoint_policy' -> 'listener_requirement' IS NULL
       OR jsonb_typeof(p_profile -> 'endpoint_policy' -> 'listener_requirement') <> 'object'
       OR jsonb_typeof(p_profile -> 'endpoint_policy' -> 'allowed_ports') <> 'array'
       OR COALESCE(jsonb_array_length(p_profile -> 'endpoint_policy' -> 'allowed_ports'), 0) NOT BETWEEN 1 AND 32
       OR (SELECT count(DISTINCT port::numeric) FROM jsonb_array_elements(
             p_profile -> 'endpoint_policy' -> 'allowed_ports') port)
          <> jsonb_array_length(p_profile -> 'endpoint_policy' -> 'allowed_ports')
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_profile -> 'endpoint_policy' -> 'allowed_ports') port
         WHERE jsonb_typeof(port) <> 'number' OR port::numeric <> trunc(port::numeric)
            OR port::numeric < 1 OR port::numeric > 65535)
       OR jsonb_typeof(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_signers') <> 'array'
       OR jsonb_typeof(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_service_sids') <> 'array'
       OR jsonb_typeof(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allow_pinned_hash') <> 'boolean'
       OR COALESCE(jsonb_array_length(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_signers'), 0) > 32
       OR COALESCE(jsonb_array_length(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_service_sids'), 0) > 32
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_signers') signer
         WHERE jsonb_typeof(signer) <> 'string' OR length(signer #>> '{}') NOT BETWEEN 1 AND 256
            OR signer #>> '{}' <> btrim(signer #>> '{}'))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_service_sids') sid
         WHERE jsonb_typeof(sid) <> 'string' OR octet_length(sid #>> '{}') NOT BETWEEN 2 AND 256
            OR sid #>> '{}' !~ '^[0-9a-f]+$')
       OR (COALESCE(jsonb_array_length(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_signers'), 0) = 0
           AND NOT COALESCE((p_profile -> 'endpoint_policy' -> 'listener_requirement' ->> 'allow_pinned_hash')::boolean, false))) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_request_hash := work.sha256_text(p_profile::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'execution_profile.publish'
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_dedup.result_ref::jsonb;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_org_id || ':execution-profile:' || v_profile_id, 0));
  SELECT COALESCE(MAX(revision), 0) + 1 INTO v_revision
  FROM work.execution_profile_revision
  WHERE org_id = p_org_id AND profile_id = v_profile_id;

  INSERT INTO work.execution_profile_revision
    (org_id, profile_id, revision, content_hash, kind, provider, model, api_type,
     residency, endpoint_policy, tokenizer_id, context_tokens, max_request_bytes,
     max_output_tokens, usage_mode, runtime_digest, tool_manifest_hash,
     compat_profile_version, max_turns, status)
  VALUES
    (p_org_id, v_profile_id, v_revision, v_content_hash,
     p_profile ->> 'kind', p_profile ->> 'provider', p_profile ->> 'model',
     p_profile ->> 'api_type', p_profile ->> 'residency', p_profile -> 'endpoint_policy',
     p_profile ->> 'tokenizer_id', (p_profile ->> 'context_tokens')::bigint,
     (p_profile ->> 'max_request_bytes')::bigint,
     (p_profile ->> 'max_output_tokens')::bigint, p_profile ->> 'usage_mode',
     p_profile ->> 'runtime_digest', p_profile ->> 'tool_manifest_hash',
     p_profile ->> 'compat_profile_version', (p_profile ->> 'max_turns')::bigint,
     v_status)
  RETURNING jsonb_build_object(
    'org_id', org_id, 'profile_id', profile_id, 'revision', revision,
    'content_hash', content_hash, 'kind', kind, 'provider', provider,
    'model', model, 'api_type', api_type, 'residency', residency,
    'endpoint_policy', endpoint_policy, 'tokenizer_id', tokenizer_id,
    'context_tokens', context_tokens, 'max_request_bytes', max_request_bytes,
    'max_output_tokens', max_output_tokens, 'usage_mode', usage_mode,
    'runtime_digest', runtime_digest, 'tool_manifest_hash', tool_manifest_hash,
    'compat_profile_version', compat_profile_version, 'max_turns', max_turns,
    'status', status, 'created_at', created_at
  ) INTO v_response;

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'execution_profile.publish', p_client_request_id,
     v_request_hash, v_response::text);

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'execution_profile.publish', 'execution_profile',
    v_profile_id,
    jsonb_build_object('revision', v_revision, 'content_hash', v_content_hash,
      'kind', p_profile ->> 'kind', 'status', v_status));
  RETURN v_response;
END;
$function$;


CREATE OR REPLACE FUNCTION work.create_device_model_binding(p_org_id text, p_actor_subject_id text, p_auth_epoch bigint, p_device_id uuid, p_session_id uuid, p_client_request_id text, p_profile_id text, p_profile_revision bigint, p_profile_hash text, p_binding_hash text, p_local_ref text, p_listener_identity_hash text, p_native_confirmation_proof jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'work', 'pg_catalog'
AS $function$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_profile work.execution_profile_revision%ROWTYPE;
  v_binding_id uuid;
  v_probe_id uuid;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_template_hash text := work.sha256_text('device-model-probe-v1');
  v_preview_hash text;
  v_response jsonb;
  v_request_hash text;
  v_proof_keys text[];
  v_expected_binding_hash text;
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
    'device.model_binding.create', p_client_request_id);

  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.work_seat AND m.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = '42501';
  END IF;

  v_request_hash := work.sha256_text(jsonb_build_object(
    'auth_epoch', p_auth_epoch, 'device_id', p_device_id, 'session_id', p_session_id,
    'profile_id', p_profile_id, 'profile_revision', p_profile_revision,
    'profile_hash', p_profile_hash, 'binding_hash', p_binding_hash,
    'local_ref', p_local_ref, 'listener_identity_hash', p_listener_identity_hash,
    'native_confirmation_proof', p_native_confirmation_proof
  )::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'device.model_binding.create'
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
     OR v_session.auth_epoch <> p_auth_epoch
     OR v_session.profile_id <> p_profile_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_profile FROM work.execution_profile_revision
  WHERE org_id = p_org_id AND profile_id = p_profile_id
    AND revision = p_profile_revision FOR SHARE;
  IF NOT FOUND OR v_profile.status <> 'active'
     OR v_profile.content_hash <> p_profile_hash
     OR v_profile.kind <> 'device_local'
     OR v_profile.max_output_tokens < 16
  THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_native_confirmation_proof IS NULL
     OR jsonb_typeof(p_native_confirmation_proof) <> 'object' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_proof_keys := ARRAY(SELECT jsonb_object_keys(p_native_confirmation_proof));
  IF cardinality(v_proof_keys) <> 17
     OR NOT v_proof_keys @> ARRAY[
       'v','org_id','subject_id','auth_epoch','device_id','session_id','profile_id',
       'profile_revision','profile_hash','binding_hash','local_ref',
       'listener_identity_hash','listener_signer_thumbprint','listener_owner_sid',
       'listener_owner_is_current_user','nonce','expires_at'] THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_expected_binding_hash := work.sha256_text(
    'device-model-binding-v1|'
    || octet_length(p_org_id)::text || ':' || p_org_id || '|'
    || octet_length(p_device_id::text)::text || ':' || p_device_id::text || '|'
    || octet_length(p_session_id::text)::text || ':' || p_session_id::text || '|'
    || octet_length(p_profile_id)::text || ':' || p_profile_id || '|'
    || octet_length(p_profile_revision::text)::text || ':' || p_profile_revision::text || '|'
    || octet_length(p_profile_hash)::text || ':' || p_profile_hash || '|'
    || octet_length(p_local_ref)::text || ':' || p_local_ref || '|'
    || octet_length(p_listener_identity_hash)::text || ':' || p_listener_identity_hash);
  IF (p_native_confirmation_proof ->> 'v') IS DISTINCT FROM '1'
     OR (p_native_confirmation_proof ->> 'org_id') IS DISTINCT FROM p_org_id
     OR (p_native_confirmation_proof ->> 'subject_id') IS DISTINCT FROM p_actor_subject_id
     OR (p_native_confirmation_proof ->> 'auth_epoch') IS DISTINCT FROM p_auth_epoch::text
     OR (p_native_confirmation_proof ->> 'device_id') IS DISTINCT FROM p_device_id::text
     OR (p_native_confirmation_proof ->> 'session_id') IS DISTINCT FROM p_session_id::text
     OR (p_native_confirmation_proof ->> 'profile_id') IS DISTINCT FROM p_profile_id
     OR (p_native_confirmation_proof ->> 'profile_revision') IS DISTINCT FROM p_profile_revision::text
     OR (p_native_confirmation_proof ->> 'profile_hash') IS DISTINCT FROM p_profile_hash
     OR (p_native_confirmation_proof ->> 'binding_hash') IS DISTINCT FROM p_binding_hash
     OR (p_native_confirmation_proof ->> 'local_ref') IS DISTINCT FROM p_local_ref
     OR (p_native_confirmation_proof ->> 'listener_identity_hash') IS DISTINCT FROM p_listener_identity_hash
     OR (p_native_confirmation_proof ->> 'listener_owner_is_current_user') NOT IN ('true', 'false')
     OR ((p_native_confirmation_proof ->> 'listener_owner_is_current_user')::boolean = false
         AND NOT COALESCE((p_native_confirmation_proof ->> 'listener_owner_sid') = ANY(
           ARRAY(SELECT jsonb_array_elements_text(
             COALESCE(v_profile.endpoint_policy -> 'listener_requirement' -> 'allowed_service_sids', '[]'::jsonb)))), false))
     OR NOT (
       COALESCE((p_native_confirmation_proof ->> 'listener_signer_thumbprint') = ANY(
         ARRAY(SELECT jsonb_array_elements_text(
           COALESCE(v_profile.endpoint_policy -> 'listener_requirement' -> 'allowed_signers', '[]'::jsonb)))), false)
       OR COALESCE((v_profile.endpoint_policy -> 'listener_requirement' ->> 'allow_pinned_hash')::boolean, false))
     OR octet_length(COALESCE(p_native_confirmation_proof ->> 'listener_owner_sid', '')) NOT BETWEEN 2 AND 256
     OR COALESCE(p_native_confirmation_proof ->> 'listener_owner_sid', '') !~ '^[0-9a-f]+$'
     OR (p_native_confirmation_proof ->> 'listener_signer_thumbprint') IS NOT NULL
        AND (length(p_native_confirmation_proof ->> 'listener_signer_thumbprint') NOT BETWEEN 1 AND 256
          OR p_native_confirmation_proof ->> 'listener_signer_thumbprint' <> btrim(p_native_confirmation_proof ->> 'listener_signer_thumbprint'))
     OR COALESCE(p_native_confirmation_proof ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR (p_native_confirmation_proof ->> 'expires_at') IS NULL
     OR (p_native_confirmation_proof ->> 'expires_at')::timestamptz <= clock_timestamp()
     OR (p_native_confirmation_proof ->> 'expires_at')::timestamptz > clock_timestamp() + interval '65 seconds'
     OR p_binding_hash <> v_expected_binding_hash
     OR p_local_ref IS NULL OR p_local_ref !~ '^http://127[.]0[.]0[.]1:[0-9]{1,5}$'
     OR substring(p_local_ref from '[0-9]+$')::integer NOT BETWEEN 1 AND 65535
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_profile.endpoint_policy -> 'allowed_ports') port
       WHERE port::numeric = substring(p_local_ref from '[0-9]+$')::numeric)
     OR p_listener_identity_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  UPDATE work.device_model_binding
  SET status = 'revoked', revision = revision + 1, updated_at = now()
  WHERE org_id = p_org_id AND device_id = p_device_id
    AND session_id = p_session_id AND profile_id = p_profile_id
    AND status = 'pending_probe'
    AND EXISTS (
      SELECT 1 FROM work.model_profile_probe old_probe
      WHERE old_probe.org_id = work.device_model_binding.org_id
        AND old_probe.binding_id = work.device_model_binding.id
        AND old_probe.expires_at <= now()
    );

  v_binding_id := gen_random_uuid();
  v_probe_id := gen_random_uuid();
  v_created_at := now();
  v_expires_at := v_created_at + interval '60 seconds';
  BEGIN
    INSERT INTO work.device_model_binding
      (org_id, id, device_id, session_id, profile_id, profile_revision,
       profile_hash, binding_hash, status, local_ref, listener_identity_hash,
       revision, created_at, updated_at)
    VALUES
      (p_org_id, v_binding_id, p_device_id, p_session_id, p_profile_id,
       p_profile_revision, p_profile_hash, p_binding_hash, 'pending_probe',
       p_local_ref, p_listener_identity_hash, 1, v_created_at, v_created_at);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END;

  v_preview_hash := work.sha256_text(jsonb_build_object(
    'org_id', p_org_id,
    'device_id', p_device_id,
    'session_id', p_session_id,
    'profile_id', p_profile_id,
    'profile_revision', p_profile_revision,
    'profile_hash', p_profile_hash,
    'binding_hash', p_binding_hash,
    'probe_id', v_probe_id,
    'template_hash', v_template_hash,
    'max_output_tokens', 16,
    'expires_at', v_expires_at
  )::text);

  INSERT INTO work.model_profile_probe
    (org_id, probe_id, binding_id, profile_id, profile_revision, profile_hash,
     candidate_hash, preview_hash, expires_at, state, created_at, updated_at)
  VALUES
    (p_org_id, v_probe_id, v_binding_id, p_profile_id, p_profile_revision,
     p_profile_hash, p_binding_hash, v_preview_hash, v_expires_at, 'queued',
     v_created_at, v_created_at);

  v_response := jsonb_build_object(
    'binding_id', v_binding_id,
    'device_id', p_device_id,
    'session_id', p_session_id,
    'profile_id', p_profile_id,
    'profile_revision', p_profile_revision,
    'profile_hash', p_profile_hash,
    'binding_hash', p_binding_hash,
    'status', 'pending_probe',
    'local_ref', p_local_ref,
    'listener_identity_hash', p_listener_identity_hash,
    'revision', 1,
    'created_at', v_created_at,
    'updated_at', v_created_at,
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
    (p_org_id, p_actor_subject_id, 'device.model_binding.create', p_client_request_id,
     v_request_hash, v_response::text);

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'device_model_binding.create', 'device_model_binding',
    v_binding_id::text,
    jsonb_build_object(
      'device_id', p_device_id, 'session_id', p_session_id,
      'profile_id', p_profile_id, 'profile_revision', p_profile_revision,
      'profile_hash', p_profile_hash, 'binding_hash', p_binding_hash,
      'listener_identity_hash', p_listener_identity_hash, 'probe_id', v_probe_id));
  RETURN v_response;
END;
$function$;


RESET ROLE;
