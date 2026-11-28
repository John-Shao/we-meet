-- 0097: resolve the active ExecutionProfile revision for device configuration.
SET ROLE work_owner;

CREATE FUNCTION work.get_active_execution_profile(
  p_org_id text,
  p_profile_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_revision bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF p_profile_id IS NULL OR length(p_profile_id) NOT BETWEEN 1 AND 128
     OR p_profile_id <> btrim(p_profile_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT p.revision INTO v_revision
  FROM work.execution_profile_revision p
  WHERE p.org_id = p_org_id AND p.profile_id = p_profile_id
    AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN work.get_execution_profile(p_org_id, p_profile_id, v_revision);
END;
$$;

REVOKE ALL ON FUNCTION work.get_active_execution_profile(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.get_active_execution_profile(text, text) TO work_api;

RESET ROLE;
