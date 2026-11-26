-- 0080: owner-scoped local preview facts for the Bearer-plane preview face.
-- work_api has no table privileges under the 0024 house rule; this getter is the
-- only path to the active device/session/grant/policy facts the preview signs.
SET ROLE work_owner;

CREATE FUNCTION work.local_preview_facts(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_grant_ids uuid[],
  p_grant_revisions text[],
  p_runtime_digest text,
  p_profile_id text
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
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
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
  IF v_session_runtime <> p_runtime_digest OR v_session_profile <> p_profile_id THEN
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

  RETURN jsonb_build_object(
    'auth_epoch', v_session_epoch::text,
    'runtime_digest', v_session_runtime,
    'profile_id', v_session_profile,
    'run_cap_tokens', v_run_cap,
    'force_ask_each', v_force_ask_each,
    'allow_auto_readonly', v_allow_auto_readonly
  );
END;
$$;

REVOKE ALL ON FUNCTION work.local_preview_facts(
  text, text, bigint, uuid, uuid, uuid[], text[], text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.local_preview_facts(
  text, text, bigint, uuid, uuid, uuid[], text[], text, text
) TO work_api;

RESET ROLE;
