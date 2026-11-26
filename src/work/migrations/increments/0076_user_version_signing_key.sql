-- 0076: owner-scoped UserVersionProof key getter for the local artifact-version face.
-- The API verifies ES256 before calling create_local_user_artifact_version, but its
-- initial key read selected device_session/device directly. work_api has no table
-- privileges under the 0024 house rule, so that read returned SQLSTATE 42501 and every
-- real local-save request degraded to 503. This getter is the narrow replacement: it
-- returns only the public JWK for the caller's active device session and never grants
-- table access. The domain command still owns proof shape, epoch/CAS and nonce checks.
SET ROLE work_owner;

CREATE FUNCTION work.user_version_signing_key(
  p_org_id text,
  p_actor_subject_id text,
  p_device_id uuid,
  p_session_id uuid
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
  FROM work.device_session s
  JOIN work.device d ON d.org_id = s.org_id AND d.id = s.device_id
  WHERE s.org_id = p_org_id
    AND s.id = p_session_id
    AND s.device_id = p_device_id
    AND s.owner_subject_id = p_actor_subject_id
    AND d.owner_subject_id = p_actor_subject_id
    AND s.state = 'active'
    AND s.expires_at > now()
    AND d.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_jwk;
END;
$$;

REVOKE ALL ON FUNCTION work.user_version_signing_key(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.user_version_signing_key(text, text, uuid, uuid) TO work_api;

RESET ROLE;
