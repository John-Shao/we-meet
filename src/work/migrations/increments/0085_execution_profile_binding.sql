-- 0085: production ExecutionProfile registry plus verified device model binding/probe gate.
--
-- The registry is the authority for immutable profile revisions. A device-local profile is not
-- executable merely because it is active: the current device/session must also have an exact
-- verified binding. local_preview_facts and submit_local_task therefore derive model/runtime/tool
-- facts from this registry instead of trusting the client selection.
--
-- No workload role receives table privileges. All access is through the narrow SECURITY DEFINER
-- commands below; verified_execution_profile is an internal helper only.

SET ROLE work_owner;

ALTER TABLE work.device_run_binding
  ADD COLUMN purpose text NOT NULL DEFAULT 'task'
  CHECK (purpose IN ('task', 'configuration_probe'));

CREATE TABLE work.execution_profile_revision (
  org_id text NOT NULL,
  profile_id text NOT NULL,
  revision bigint NOT NULL,
  content_hash text NOT NULL,
  kind text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  api_type text NOT NULL,
  residency text NOT NULL,
  endpoint_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokenizer_id text NOT NULL,
  context_tokens bigint NOT NULL,
  max_request_bytes bigint NOT NULL,
  max_output_tokens bigint NOT NULL,
  usage_mode text NOT NULL,
  runtime_digest text NOT NULL,
  tool_manifest_hash text NOT NULL,
  compat_profile_version text NOT NULL,
  max_turns bigint NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, profile_id, revision),
  CONSTRAINT execution_profile_revision_org_fkey
    FOREIGN KEY (org_id) REFERENCES work.org(id),
  CONSTRAINT execution_profile_revision_id_shape
    CHECK (profile_id <> '' AND length(profile_id) <= 128 AND profile_id = btrim(profile_id)),
  CONSTRAINT execution_profile_revision_number_positive CHECK (revision >= 1),
  CONSTRAINT execution_profile_revision_content_hash_shape
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_profile_revision_kind_check
    CHECK (kind IN ('device_local', 'org_private', 'org_remote')),
  CONSTRAINT execution_profile_revision_provider_shape
    CHECK (provider <> '' AND length(provider) <= 128),
  CONSTRAINT execution_profile_revision_model_shape
    CHECK (model <> '' AND length(model) <= 256),
  CONSTRAINT execution_profile_revision_api_type_check
    CHECK (api_type IN ('chat_completions', 'responses')),
  CONSTRAINT execution_profile_revision_residency_shape
    CHECK (residency <> '' AND length(residency) <= 128),
  CONSTRAINT execution_profile_revision_endpoint_policy_object
    CHECK (jsonb_typeof(endpoint_policy) = 'object'),
  CONSTRAINT execution_profile_revision_tokenizer_shape
    CHECK (tokenizer_id <> '' AND length(tokenizer_id) <= 128),
  CONSTRAINT execution_profile_revision_context_positive CHECK (context_tokens > 0),
  CONSTRAINT execution_profile_revision_request_bytes_positive CHECK (max_request_bytes > 0),
  CONSTRAINT execution_profile_revision_output_tokens_positive CHECK (max_output_tokens > 0),
  CONSTRAINT execution_profile_revision_usage_mode_check
    CHECK (usage_mode IN ('actual', 'estimated')),
  CONSTRAINT execution_profile_revision_runtime_shape
    CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_profile_revision_tool_manifest_shape
    CHECK (tool_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_profile_revision_compat_shape
    CHECK (compat_profile_version <> '' AND length(compat_profile_version) <= 64),
  CONSTRAINT execution_profile_revision_turns_positive CHECK (max_turns > 0),
  CONSTRAINT execution_profile_revision_status_check
    CHECK (status IN ('draft', 'active', 'revoked')),
  CONSTRAINT execution_profile_revision_device_local_listener_requirement CHECK (
    kind <> 'device_local' OR (
      jsonb_typeof(endpoint_policy -> 'listener_requirement') = 'object'
      AND (
        COALESCE(jsonb_array_length(endpoint_policy -> 'listener_requirement' -> 'allowed_signers'), 0) > 0
        OR COALESCE((endpoint_policy -> 'listener_requirement' ->> 'allow_pinned_hash')::boolean, false)
        OR COALESCE(jsonb_array_length(endpoint_policy -> 'listener_requirement' -> 'allowed_service_sids'), 0) > 0
      )
    )
  )
);

ALTER TABLE work.execution_profile_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.execution_profile_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.execution_profile_revision
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.execution_profile_revision_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft' AND NEW.status = 'active')
           OR (OLD.status = 'active' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'invalid_transition:execution_profile_revision:status' USING ERRCODE = '23514';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.api_type IS DISTINCT FROM OLD.api_type
     OR NEW.residency IS DISTINCT FROM OLD.residency
     OR NEW.endpoint_policy IS DISTINCT FROM OLD.endpoint_policy
     OR NEW.tokenizer_id IS DISTINCT FROM OLD.tokenizer_id
     OR NEW.context_tokens IS DISTINCT FROM OLD.context_tokens
     OR NEW.max_request_bytes IS DISTINCT FROM OLD.max_request_bytes
     OR NEW.max_output_tokens IS DISTINCT FROM OLD.max_output_tokens
     OR NEW.usage_mode IS DISTINCT FROM OLD.usage_mode
     OR NEW.runtime_digest IS DISTINCT FROM OLD.runtime_digest
     OR NEW.tool_manifest_hash IS DISTINCT FROM OLD.tool_manifest_hash
     OR NEW.compat_profile_version IS DISTINCT FROM OLD.compat_profile_version
     OR NEW.max_turns IS DISTINCT FROM OLD.max_turns
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'execution_profile_revision_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_profile_revision_guard
  BEFORE UPDATE ON work.execution_profile_revision
  FOR EACH ROW EXECUTE FUNCTION work.execution_profile_revision_guard();
CREATE TRIGGER execution_profile_revision_no_delete
  BEFORE DELETE ON work.execution_profile_revision
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
REVOKE ALL ON FUNCTION work.execution_profile_revision_guard() FROM PUBLIC;

CREATE TABLE work.device_model_binding (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  profile_id text NOT NULL,
  profile_revision bigint NOT NULL,
  profile_hash text NOT NULL,
  binding_hash text NOT NULL,
  status text NOT NULL,
  local_ref text NOT NULL,
  listener_identity_hash text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT device_model_binding_org_fkey
    FOREIGN KEY (org_id) REFERENCES work.org(id),
  CONSTRAINT device_model_binding_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_model_binding_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT device_model_binding_profile_fkey
    FOREIGN KEY (org_id, profile_id, profile_revision)
    REFERENCES work.execution_profile_revision(org_id, profile_id, revision),
  CONSTRAINT device_model_binding_profile_revision_positive CHECK (profile_revision >= 1),
  CONSTRAINT device_model_binding_profile_hash_shape
    CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_model_binding_hash_shape
    CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_model_binding_status_check
    CHECK (status IN ('pending_probe', 'verified', 'identity_mismatch', 'revoked')),
  CONSTRAINT device_model_binding_local_ref_shape
    CHECK (local_ref <> '' AND length(local_ref) <= 512),
  CONSTRAINT device_model_binding_listener_identity_shape
    CHECK (listener_identity_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_model_binding_revision_positive CHECK (revision >= 1)
);

ALTER TABLE work.device_model_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_model_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_model_binding
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE UNIQUE INDEX work_device_model_binding_one_active
  ON work.device_model_binding(org_id, device_id, session_id, profile_id)
  WHERE status <> 'revoked';

CREATE FUNCTION work.device_model_binding_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'pending_probe' AND NEW.status = 'verified')
           OR (OLD.status IN ('pending_probe', 'verified') AND NEW.status = 'identity_mismatch')
           OR NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'invalid_transition:device_model_binding:status' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'invalid_transition:device_model_binding:revision' USING ERRCODE = '23514';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.profile_revision IS DISTINCT FROM OLD.profile_revision
     OR NEW.profile_hash IS DISTINCT FROM OLD.profile_hash
     OR NEW.binding_hash IS DISTINCT FROM OLD.binding_hash
     OR NEW.local_ref IS DISTINCT FROM OLD.local_ref
     OR NEW.listener_identity_hash IS DISTINCT FROM OLD.listener_identity_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_model_binding_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_model_binding_guard
  BEFORE UPDATE ON work.device_model_binding
  FOR EACH ROW EXECUTE FUNCTION work.device_model_binding_guard();
CREATE TRIGGER device_model_binding_no_delete
  BEFORE DELETE ON work.device_model_binding
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
REVOKE ALL ON FUNCTION work.device_model_binding_guard() FROM PUBLIC;

CREATE TABLE work.model_profile_probe (
  org_id text NOT NULL,
  probe_id uuid NOT NULL DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL,
  profile_id text NOT NULL,
  profile_revision bigint NOT NULL,
  profile_hash text NOT NULL,
  candidate_hash text NOT NULL,
  preview_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL,
  receipt_ref text,
  task_id uuid,
  run_id uuid,
  operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, probe_id),
  CONSTRAINT model_profile_probe_org_fkey
    FOREIGN KEY (org_id) REFERENCES work.org(id),
  CONSTRAINT model_profile_probe_binding_fkey
    FOREIGN KEY (binding_id, org_id) REFERENCES work.device_model_binding(id, org_id),
  CONSTRAINT model_profile_probe_profile_fkey
    FOREIGN KEY (org_id, profile_id, profile_revision)
    REFERENCES work.execution_profile_revision(org_id, profile_id, revision),
  CONSTRAINT model_profile_probe_profile_revision_positive CHECK (profile_revision >= 1),
  CONSTRAINT model_profile_probe_profile_hash_shape
    CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT model_profile_probe_candidate_hash_shape
    CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT model_profile_probe_preview_hash_shape
    CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT model_profile_probe_window CHECK (expires_at > created_at),
  CONSTRAINT model_profile_probe_state_check
    CHECK (state IN ('queued', 'running', 'verified', 'failed', 'reconcile')),
  CONSTRAINT model_profile_probe_receipt_ref_shape
    CHECK (receipt_ref IS NULL OR (receipt_ref <> '' AND length(receipt_ref) <= 512)),
  CONSTRAINT model_profile_probe_task_fkey
    FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  CONSTRAINT model_profile_probe_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT model_profile_probe_operation_fkey
    FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  UNIQUE (org_id, receipt_ref)
);

ALTER TABLE work.model_profile_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.model_profile_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.model_profile_probe
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.model_profile_probe_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT ((OLD.state = 'queued' AND NEW.state IN ('running', 'verified', 'failed', 'reconcile'))
           OR (OLD.state = 'running' AND NEW.state IN ('verified', 'failed', 'reconcile'))
           OR NEW.state = OLD.state) THEN
    RAISE EXCEPTION 'invalid_transition:model_profile_probe:state' USING ERRCODE = '23514';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.probe_id IS DISTINCT FROM OLD.probe_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.profile_revision IS DISTINCT FROM OLD.profile_revision
     OR NEW.profile_hash IS DISTINCT FROM OLD.profile_hash
     OR NEW.candidate_hash IS DISTINCT FROM OLD.candidate_hash
     OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'model_profile_probe_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER model_profile_probe_guard
  BEFORE UPDATE ON work.model_profile_probe
  FOR EACH ROW EXECUTE FUNCTION work.model_profile_probe_guard();
CREATE TRIGGER model_profile_probe_no_delete
  BEFORE DELETE ON work.model_profile_probe
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
REVOKE ALL ON FUNCTION work.model_profile_probe_guard() FROM PUBLIC;

REVOKE ALL ON TABLE work.execution_profile_revision FROM PUBLIC;
REVOKE ALL ON TABLE work.execution_profile_revision FROM work_api, work_worker;
REVOKE ALL ON TABLE work.device_model_binding FROM PUBLIC;
REVOKE ALL ON TABLE work.device_model_binding FROM work_api, work_worker;
REVOKE ALL ON TABLE work.model_profile_probe FROM PUBLIC;
REVOKE ALL ON TABLE work.model_profile_probe FROM work_api, work_worker;

-- Publish one immutable revision. SQL computes content_hash over the closed profile document
-- (status excluded) so clients never have to reproduce PostgreSQL jsonb text ordering.
CREATE FUNCTION work.publish_execution_profile(
  p_org_id text,
  p_actor_subject_id text,
  p_client_request_id text,
  p_profile jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
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
       OR (COALESCE(jsonb_array_length(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_signers'), 0) = 0
           AND NOT COALESCE((p_profile -> 'endpoint_policy' -> 'listener_requirement' ->> 'allow_pinned_hash')::boolean, false)
           AND COALESCE(jsonb_array_length(p_profile -> 'endpoint_policy' -> 'listener_requirement' -> 'allowed_service_sids'), 0) = 0)) THEN
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
$$;

REVOKE ALL ON FUNCTION work.publish_execution_profile(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.publish_execution_profile(text, text, text, jsonb) TO work_api;

CREATE FUNCTION work.get_execution_profile(
  p_org_id text,
  p_profile_id text,
  p_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id
      AND m.subject_id = current_setting('app.subject_id', true)
      AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_build_object(
    'org_id', org_id, 'profile_id', profile_id, 'revision', revision,
    'content_hash', content_hash, 'kind', kind, 'provider', provider,
    'model', model, 'api_type', api_type, 'residency', residency,
    'endpoint_policy', endpoint_policy, 'tokenizer_id', tokenizer_id,
    'context_tokens', context_tokens, 'max_request_bytes', max_request_bytes,
    'max_output_tokens', max_output_tokens, 'usage_mode', usage_mode,
    'runtime_digest', runtime_digest, 'tool_manifest_hash', tool_manifest_hash,
    'compat_profile_version', compat_profile_version, 'max_turns', max_turns,
    'status', status, 'created_at', created_at
  ) INTO v_response
  FROM work.execution_profile_revision
  WHERE org_id = p_org_id AND profile_id = p_profile_id
    AND revision = p_revision AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION work.get_execution_profile(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.get_execution_profile(text, text, bigint) TO work_api;

-- Internal gate used by preview and submission. It is deliberately not granted to work_api:
-- callers must go through local_preview_facts/submit_local_task, which first bind the actor,
-- device owner, current session, epoch and workspace grants.
CREATE FUNCTION work.verified_execution_profile(
  p_org_id text,
  p_device_id uuid,
  p_session_id uuid,
  p_profile_id text,
  p_profile_revision bigint,
  p_profile_hash text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  SELECT jsonb_build_object(
    'org_id', p.org_id, 'profile_id', p.profile_id, 'revision', p.revision,
    'content_hash', p.content_hash, 'kind', p.kind, 'provider', p.provider,
    'model', p.model, 'api_type', p.api_type, 'residency', p.residency,
    'endpoint_policy', p.endpoint_policy, 'tokenizer_id', p.tokenizer_id,
    'context_tokens', p.context_tokens, 'max_request_bytes', p.max_request_bytes,
    'max_output_tokens', p.max_output_tokens, 'usage_mode', p.usage_mode,
    'runtime_digest', p.runtime_digest, 'tool_manifest_hash', p.tool_manifest_hash,
    'compat_profile_version', p.compat_profile_version, 'max_turns', p.max_turns,
    'status', p.status, 'binding_id', b.id, 'binding_hash', b.binding_hash,
    'listener_identity_hash', b.listener_identity_hash
  ) INTO v_response
  FROM work.execution_profile_revision p
  JOIN work.device_model_binding b
    ON b.org_id = p.org_id AND b.profile_id = p.profile_id
   AND b.profile_revision = p.revision AND b.profile_hash = p.content_hash
  JOIN work.device_session s
    ON s.org_id = b.org_id AND s.id = b.session_id AND s.device_id = b.device_id
  JOIN work.device d
    ON d.org_id = s.org_id AND d.id = s.device_id
  WHERE p.org_id = p_org_id
    AND p.profile_id = p_profile_id
    AND p.revision = p_profile_revision
    AND p.content_hash = p_profile_hash
    AND p.status = 'active'
    AND b.device_id = p_device_id
    AND b.session_id = p_session_id
    AND b.status = 'verified'
    AND s.profile_id = p_profile_id
    AND s.state = 'active'
    AND s.expires_at > now()
    AND d.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION work.verified_execution_profile(text, uuid, uuid, text, bigint, text) FROM PUBLIC;

CREATE FUNCTION work.create_device_model_binding(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_client_request_id text,
  p_profile_id text,
  p_profile_revision bigint,
  p_profile_hash text,
  p_binding_hash text,
  p_local_ref text,
  p_listener_identity_hash text,
  p_native_confirmation_proof jsonb
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
     OR (NOT COALESCE((v_profile.endpoint_policy -> 'listener_requirement' ->> 'allow_pinned_hash')::boolean, false)
         AND NOT v_device.public_key_thumbprint = ANY(
           ARRAY(SELECT jsonb_array_elements_text(
             COALESCE(v_profile.endpoint_policy -> 'listener_requirement' -> 'allowed_signers', '[]'::jsonb)))))
  THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_native_confirmation_proof IS NULL
     OR jsonb_typeof(p_native_confirmation_proof) <> 'object' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_proof_keys := ARRAY(SELECT jsonb_object_keys(p_native_confirmation_proof));
  IF cardinality(v_proof_keys) <> 14
     OR NOT v_proof_keys @> ARRAY[
       'v','org_id','subject_id','auth_epoch','device_id','session_id','profile_id',
       'profile_revision','profile_hash','binding_hash','local_ref',
       'listener_identity_hash','nonce','expires_at'] THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_expected_binding_hash := work.sha256_text(
    'device-model-binding-v1|'
    || length(p_org_id)::text || ':' || p_org_id || '|'
    || length(p_device_id::text)::text || ':' || p_device_id::text || '|'
    || length(p_session_id::text)::text || ':' || p_session_id::text || '|'
    || length(p_profile_id)::text || ':' || p_profile_id || '|'
    || length(p_profile_revision::text)::text || ':' || p_profile_revision::text || '|'
    || length(p_profile_hash)::text || ':' || p_profile_hash || '|'
    || length(p_local_ref)::text || ':' || p_local_ref || '|'
    || length(p_listener_identity_hash)::text || ':' || p_listener_identity_hash);
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
     OR COALESCE(p_native_confirmation_proof ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR (p_native_confirmation_proof ->> 'expires_at') IS NULL
     OR (p_native_confirmation_proof ->> 'expires_at')::timestamptz <= now()
     OR (p_native_confirmation_proof ->> 'expires_at')::timestamptz > now() + interval '65 seconds'
     OR p_binding_hash <> v_expected_binding_hash
     OR p_local_ref IS NULL OR p_local_ref = '' OR length(p_local_ref) > 512
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
$$;

REVOKE ALL ON FUNCTION work.create_device_model_binding(
  text, text, bigint, uuid, uuid, text, text, bigint, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.create_device_model_binding(
  text, text, bigint, uuid, uuid, text, text, bigint, text, text, text, text, jsonb
) TO work_api;

CREATE FUNCTION work.record_execution_profile_probe(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_client_request_id text,
  p_probe_id uuid,
  p_preview_hash text,
  p_receipt_hash text,
  p_receipt_ref text,
  p_state text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_binding work.device_model_binding%ROWTYPE;
  v_probe work.model_profile_probe%ROWTYPE;
  v_result work.device_model_result%ROWTYPE;
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
    'device.model_probe.record', p_client_request_id);

  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.work_seat AND m.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = '42501';
  END IF;
  IF p_state NOT IN ('running', 'verified', 'failed', 'reconcile') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_request_hash := work.sha256_text(jsonb_build_object(
    'auth_epoch', p_auth_epoch, 'device_id', p_device_id, 'session_id', p_session_id,
    'probe_id', p_probe_id, 'preview_hash', p_preview_hash,
    'receipt_hash', p_receipt_hash, 'receipt_ref', p_receipt_ref, 'state', p_state
  )::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'device.model_probe.record'
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_dedup.result_ref::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM work.device d
    JOIN work.device_session s
      ON s.org_id = d.org_id AND s.device_id = d.id AND s.id = p_session_id
    WHERE d.org_id = p_org_id AND d.id = p_device_id
      AND d.owner_subject_id = p_actor_subject_id
      AND d.status = 'active' AND d.auth_plane = 'bearer'
      AND d.auth_epoch = p_auth_epoch
      AND s.owner_subject_id = p_actor_subject_id
      AND s.state = 'active' AND s.expires_at > now()
      AND s.auth_plane = 'bearer' AND s.auth_epoch = p_auth_epoch
  ) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_probe FROM work.model_profile_probe
  WHERE org_id = p_org_id AND probe_id = p_probe_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF (v_probe.preview_hash <> p_preview_hash
      OR (v_probe.expires_at <= now() AND p_state NOT IN ('failed', 'reconcile'))) THEN
    RAISE EXCEPTION 'preview_stale' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_model_binding
  WHERE org_id = p_org_id AND id = v_probe.binding_id FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id <> p_device_id
     OR v_binding.session_id <> p_session_id
     OR v_binding.profile_id <> v_probe.profile_id
     OR v_binding.profile_revision <> v_probe.profile_revision
     OR v_binding.profile_hash <> v_probe.profile_hash THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_binding.status <> 'pending_probe'
     OR v_probe.state NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.execution_profile_revision p
    JOIN work.device_session s
      ON s.org_id = p.org_id AND s.id = p_session_id AND s.device_id = p_device_id
    WHERE p.org_id = p_org_id AND p.profile_id = v_probe.profile_id
      AND p.revision = v_probe.profile_revision AND p.content_hash = v_probe.profile_hash
      AND p.status = 'active' AND s.profile_id = p.profile_id
  ) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_state = 'verified' THEN
    IF p_receipt_ref IS NULL OR p_receipt_ref !~ '^model_result:[0-9a-f-]{36}$'
       OR p_receipt_hash IS NULL OR p_receipt_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_result FROM work.device_model_result
    WHERE org_id = p_org_id
      AND model_result_id = substring(p_receipt_ref from '^model_result:([0-9a-f-]{36})$')::uuid
    FOR SHARE;
    IF NOT FOUND OR v_result.device_id <> p_device_id
       OR v_result.session_id <> p_session_id
       OR v_result.state <> 'completed' OR v_result.outcome <> 'succeeded'
       OR v_result.request_hash <> v_probe.preview_hash
       OR v_result.result_hash <> p_receipt_hash
       OR v_result.output_tokens > 16
       OR v_result.recorded_at < v_probe.created_at
       OR NOT EXISTS (
         SELECT 1 FROM work.device_run_binding drb
         WHERE drb.org_id = p_org_id AND drb.run_id = v_result.run_id
           AND drb.device_id = p_device_id AND drb.session_id = p_session_id
           AND drb.profile_id = v_probe.profile_id
           AND drb.profile_revision = v_probe.profile_revision
           AND drb.runtime_digest = (
             SELECT runtime_digest FROM work.execution_profile_revision
             WHERE org_id = p_org_id AND profile_id = v_probe.profile_id
               AND revision = v_probe.profile_revision
           )
           AND drb.tool_manifest_hash = (
             SELECT tool_manifest_hash FROM work.execution_profile_revision
             WHERE org_id = p_org_id AND profile_id = v_probe.profile_id
               AND revision = v_probe.profile_revision
           )
           AND drb.model_version = (
             SELECT model FROM work.execution_profile_revision
             WHERE org_id = p_org_id AND profile_id = v_probe.profile_id
               AND revision = v_probe.profile_revision
           )
           AND drb.purpose = 'configuration_probe'
       )
       OR v_result.model <> (
         SELECT model FROM work.execution_profile_revision
         WHERE org_id = p_org_id AND profile_id = v_probe.profile_id
           AND revision = v_probe.profile_revision
       ) THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
  ELSIF p_state IN ('failed', 'reconcile')
     AND (p_receipt_ref IS NULL OR p_receipt_ref = '') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_receipt_hash IS NOT NULL AND p_receipt_hash <> '' AND p_receipt_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  UPDATE work.model_profile_probe
  SET state = p_state,
      receipt_ref = COALESCE(p_receipt_ref, receipt_ref),
      task_id = CASE WHEN p_state = 'verified' THEN (
        SELECT t.id FROM work.run r JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
        WHERE r.id = v_result.run_id AND r.org_id = p_org_id
      ) ELSE task_id END,
      run_id = CASE WHEN p_state = 'verified' THEN v_result.run_id ELSE run_id END,
      operation_id = CASE WHEN p_state = 'verified' THEN v_result.operation_id ELSE operation_id END,
      updated_at = now()
  WHERE org_id = p_org_id AND probe_id = p_probe_id;

  IF p_state = 'verified' THEN
    UPDATE work.device_model_binding
    SET status = 'verified', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = v_binding.id;
  ELSIF p_state IN ('failed', 'reconcile') THEN
    UPDATE work.device_model_binding
    SET status = 'revoked', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = v_binding.id;
  END IF;

  SELECT jsonb_build_object(
    'probe_id', p.probe_id, 'binding_id', p.binding_id,
    'profile_id', p.profile_id, 'profile_revision', p.profile_revision,
    'profile_hash', p.profile_hash, 'candidate_hash', p.candidate_hash,
    'state', p.state, 'receipt_ref', p.receipt_ref,
    'binding_status', b.status, 'binding_revision', b.revision,
    'updated_at', p.updated_at
  ) INTO v_response
  FROM work.model_profile_probe p
  JOIN work.device_model_binding b
    ON b.org_id = p.org_id AND b.id = p.binding_id
  WHERE p.org_id = p_org_id AND p.probe_id = p_probe_id;

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'device.model_probe.record', p_client_request_id,
     v_request_hash, v_response::text);

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'model_profile_probe.record', 'model_profile_probe',
    p_probe_id::text,
    jsonb_build_object(
      'binding_id', v_binding.id, 'device_id', p_device_id,
      'session_id', p_session_id, 'profile_id', v_probe.profile_id,
      'profile_revision', v_probe.profile_revision, 'state', p_state,
      'receipt_hash', p_receipt_hash));
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION work.record_execution_profile_probe(
  text, text, bigint, uuid, uuid, text, uuid, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_execution_profile_probe(
  text, text, bigint, uuid, uuid, text, uuid, text, text, text, text
) TO work_api;

-- Restate the preview getter with the complete immutable profile selection. The old nine-arg
-- shape is removed rather than left as a second, weaker authority.
DROP FUNCTION IF EXISTS work.local_preview_facts(
  text, text, bigint, uuid, uuid, uuid[], text[], text, text
);

CREATE FUNCTION work.local_preview_facts(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_grant_ids uuid[],
  p_grant_revisions text[],
  p_runtime_digest text,
  p_profile_id text,
  p_profile_revision bigint,
  p_profile_hash text,
  p_tool_manifest_hash text,
  p_model_version text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_session_epoch bigint;
  v_session_runtime text;
  v_session_profile text;
  v_run_cap bigint;
  v_force_ask_each boolean;
  v_allow_auto_readonly boolean;
  v_active_grants integer;
  v_grant record;
  v_expected_revision text;
  v_profile jsonb;
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
  IF p_grant_ids IS NULL OR p_grant_revisions IS NULL
     OR cardinality(p_grant_ids) < 1 OR cardinality(p_grant_ids) > 4
     OR cardinality(p_grant_ids) <> cardinality(p_grant_revisions) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT s.auth_epoch, s.runtime_digest, COALESCE(s.profile_id, ''),
         p.run_cap_tokens, p.force_ask_each, p.allow_auto_readonly
    INTO v_session_epoch, v_session_runtime, v_session_profile,
         v_run_cap, v_force_ask_each, v_allow_auto_readonly
  FROM work.device_session s
  JOIN work.device d ON d.org_id = s.org_id AND d.id = s.device_id
  JOIN work.org_policy p ON p.org_id = d.org_id
  WHERE s.org_id = p_org_id
    AND s.id = p_session_id
    AND s.device_id = p_device_id
    AND s.owner_subject_id = p_actor_subject_id
    AND d.owner_subject_id = p_actor_subject_id
    AND s.auth_plane = 'bearer'
    AND s.state = 'active'
    AND s.expires_at > now()
    AND d.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_session_epoch <> p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  v_profile := work.verified_execution_profile(
    p_org_id, p_device_id, p_session_id, p_profile_id,
    p_profile_revision, p_profile_hash);
  IF v_session_runtime <> p_runtime_digest
     OR v_session_profile <> p_profile_id
     OR v_profile ->> 'runtime_digest' <> p_runtime_digest
     OR v_profile ->> 'tool_manifest_hash' <> p_tool_manifest_hash
     OR v_profile ->> 'model' <> p_model_version THEN
    RAISE EXCEPTION 'preview_stale' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_active_grants
  FROM work.workspace_grant g
  WHERE g.org_id = p_org_id
    AND g.owner_subject_id = p_actor_subject_id
    AND g.device_id = p_device_id
    AND g.session_id = p_session_id
    AND g.state = 'active'
    AND g.expires_at > now()
    AND g.id = ANY(p_grant_ids);
  IF v_active_grants <> cardinality(p_grant_ids) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  FOR v_grant IN
    SELECT id, grant_revision::text AS revision
    FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = ANY(p_grant_ids)
  LOOP
    v_expected_revision := p_grant_revisions[array_position(p_grant_ids, v_grant.id)];
    IF v_grant.revision <> v_expected_revision THEN
      RAISE EXCEPTION 'preview_stale' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN v_profile || jsonb_build_object(
    'auth_epoch', v_session_epoch::text,
    'run_cap_tokens', v_run_cap,
    'force_ask_each', v_force_ask_each,
    'allow_auto_readonly', v_allow_auto_readonly
  );
END;
$$;

REVOKE ALL ON FUNCTION work.local_preview_facts(
  text, text, bigint, uuid, uuid, uuid[], text[], text, text, bigint, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.local_preview_facts(
  text, text, bigint, uuid, uuid, uuid[], text[], text, text, bigint, text, text, text
) TO work_api;

-- Submission keeps the frozen 19-key local_intent. It now derives the canonical profile through
-- the same verified gate as preview, rejects any client/runtime/tool/model drift, and writes the
-- registry values into device_run_binding.
CREATE OR REPLACE FUNCTION work.submit_local_task(
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
  v_profile jsonb;
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
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM work.device
  WHERE org_id = p_org_id AND id = (p_target_selection->>'device_id')::uuid
    AND status = 'active' FOR SHARE;
  PERFORM 1 FROM work.device_session
  WHERE org_id = p_org_id AND id = (p_target_selection->>'session_id')::uuid
    AND device_id = (p_target_selection->>'device_id')::uuid
    AND state = 'active' AND expires_at > now() FOR SHARE;
  PERFORM 1 FROM work.workspace_grant
  WHERE org_id = p_org_id AND id = ANY(v_grant_ids)
  ORDER BY id FOR SHARE;
  IF (SELECT count(*) FROM work.workspace_grant
      WHERE org_id = p_org_id AND id = ANY(v_grant_ids)) <> cardinality(v_grant_ids) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  v_facts := work.local_preview_facts(
    p_org_id, p_actor_subject_id, p_auth_epoch,
    (p_target_selection->>'device_id')::uuid,
    (p_target_selection->>'session_id')::uuid,
    v_grant_ids, v_grant_revisions,
    p_target_selection->>'runtime_digest', p_target_selection->>'profile_id',
    (p_target_selection->>'profile_revision')::bigint,
    p_target_selection->>'profile_hash',
    p_target_selection->>'tool_manifest_hash',
    p_target_selection->>'model_version'
  );
  v_profile := work.verified_execution_profile(
    p_org_id,
    (p_target_selection->>'device_id')::uuid,
    (p_target_selection->>'session_id')::uuid,
    p_target_selection->>'profile_id',
    (p_target_selection->>'profile_revision')::bigint,
    p_target_selection->>'profile_hash'
  );
  IF (v_profile ->> 'max_request_bytes')::bigint < p_input_bytes THEN
    RAISE EXCEPTION 'input_limit_exceeded' USING ERRCODE = '22023';
  END IF;
  IF v_profile ->> 'runtime_digest' <> p_target_selection->>'runtime_digest'
     OR v_profile ->> 'tool_manifest_hash' <> p_target_selection->>'tool_manifest_hash'
     OR v_profile ->> 'model' <> p_target_selection->>'model_version'
     OR p_model_route ->> 'model' <> v_profile ->> 'model' THEN
    RAISE EXCEPTION 'preview_stale' USING ERRCODE = 'P0001';
  END IF;

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
    '', v_profile ->> 'runtime_digest'
  );

  -- submit_task owns the Task/Run locks. Recheck the executable profile under the same
  -- device/session/profile lock order used by permit minting so a concurrent revoke cannot
  -- commit between the preview gate and the binding write.
  PERFORM 1 FROM work.execution_profile_revision profile
    WHERE profile.org_id = p_org_id AND profile.profile_id = p_target_selection->>'profile_id'
      AND profile.revision = (p_target_selection->>'profile_revision')::bigint
      AND profile.content_hash = p_target_selection->>'profile_hash'
      AND profile.status = 'active' FOR SHARE;
  PERFORM 1 FROM work.device_model_binding
    WHERE org_id = p_org_id
      AND device_id = (p_target_selection->>'device_id')::uuid
      AND session_id = (p_target_selection->>'session_id')::uuid
      AND profile_id = p_target_selection->>'profile_id'
      AND profile_revision = (p_target_selection->>'profile_revision')::bigint
      AND profile_hash = p_target_selection->>'profile_hash'
      AND status = 'verified' FOR SHARE;
  v_profile := work.verified_execution_profile(
    p_org_id,
    (p_target_selection->>'device_id')::uuid,
    (p_target_selection->>'session_id')::uuid,
    p_target_selection->>'profile_id',
    (p_target_selection->>'profile_revision')::bigint,
    p_target_selection->>'profile_hash'
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
     v_profile ->> 'profile_id', (v_profile ->> 'revision')::bigint,
     v_profile ->> 'runtime_digest', v_profile ->> 'tool_manifest_hash',
     v_profile ->> 'model', p_target_selection->'workspace_grants',
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

RESET ROLE;
