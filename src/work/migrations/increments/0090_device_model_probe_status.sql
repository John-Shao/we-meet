-- 0090: device-owned configuration probe status read.
SET ROLE work_owner;

CREATE FUNCTION work.get_device_model_probe(
  p_org_id text,
  p_actor_subject_id text,
  p_device_id uuid,
  p_probe_id uuid
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
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF NOT EXISTS (
    SELECT 1 FROM work.org
    WHERE id = p_org_id AND status = 'active' AND execution_enabled
      AND NOT operator_suspended
  ) THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_build_object(
    'probe_id', mp.probe_id,
    'binding_id', mp.binding_id,
    'profile_id', mp.profile_id,
    'profile_revision', mp.profile_revision,
    'preview_hash', mp.preview_hash,
    'state', mp.state,
    'expires_at', mp.expires_at,
    'created_at', mp.created_at,
    'updated_at', mp.updated_at,
    'task_id', mp.task_id,
    'run_id', mp.run_id,
    'operation_id', mp.operation_id,
    'usage', CASE WHEN dmr.model_result_id IS NULL THEN NULL ELSE jsonb_build_object(
      'input_tokens', dmr.input_tokens,
      'output_tokens', dmr.output_tokens,
      'cached_input_tokens', dmr.cached_input_tokens,
      'usage_estimated', dmr.usage_estimated
    ) END,
    'safe_error', CASE WHEN mp.state IN ('failed', 'reconcile') THEN 'probe_failed' ELSE NULL END
  )
  INTO v_result
  FROM work.model_profile_probe mp
  JOIN work.device_model_binding dmb
    ON dmb.org_id = mp.org_id AND dmb.id = mp.binding_id
  JOIN work.device d
    ON d.org_id = dmb.org_id AND d.id = dmb.device_id
  LEFT JOIN work.device_model_result dmr
    ON dmr.org_id = mp.org_id AND dmr.operation_id = mp.operation_id
  WHERE mp.org_id = p_org_id
    AND dmb.device_id = p_device_id
    AND mp.probe_id = p_probe_id
    AND d.owner_subject_id = p_actor_subject_id
    AND d.status = 'active';

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION work.get_device_model_probe(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.get_device_model_probe(text, text, uuid, uuid) TO work_api;

RESET ROLE;
