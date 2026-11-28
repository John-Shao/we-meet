-- 0096: owner-only ExecutionProfile lifecycle listing.
SET ROLE work_owner;

CREATE FUNCTION work.list_execution_profiles(
  p_org_id text,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_result jsonb;
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

  WITH ranked AS (
    SELECT p.*,
      row_number() OVER (PARTITION BY p.profile_id ORDER BY p.revision DESC) AS rn,
      (SELECT active.revision
       FROM work.execution_profile_revision active
       WHERE active.org_id = p.org_id AND active.profile_id = p.profile_id
         AND active.status = 'active') AS active_revision
    FROM work.execution_profile_revision p
    WHERE p.org_id = p_org_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'profile_id', profile_id,
    'revision', revision,
    'content_hash', content_hash,
    'kind', kind,
    'provider', provider,
    'model', model,
    'api_type', api_type,
    'residency', residency,
    'endpoint_policy', endpoint_policy,
    'tokenizer_id', tokenizer_id,
    'context_tokens', context_tokens,
    'max_request_bytes', max_request_bytes,
    'max_output_tokens', max_output_tokens,
    'usage_mode', usage_mode,
    'runtime_digest', runtime_digest,
    'tool_manifest_hash', tool_manifest_hash,
    'compat_profile_version', compat_profile_version,
    'max_turns', max_turns,
    'status', status,
    'active_revision', active_revision,
    'created_at', created_at,
    'updated_at', updated_at
  ) ORDER BY profile_id), '[]'::jsonb)
  INTO v_result
  FROM ranked
  WHERE rn = 1;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION work.list_execution_profiles(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_execution_profiles(text, text) TO work_api;

RESET ROLE;
