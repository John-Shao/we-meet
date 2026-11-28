-- 0093: atomic device-local ExecutionProfile activation with optimistic concurrency.
SET ROLE work_owner;

ALTER TABLE work.execution_profile_revision
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX work_execution_profile_one_active
  ON work.execution_profile_revision(org_id, profile_id)
  WHERE status = 'active';

CREATE FUNCTION work.activate_execution_profile(
  p_org_id text,
  p_actor_subject_id text,
  p_client_request_id text,
  p_profile_id text,
  p_revision bigint,
  p_expected_active_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_target work.execution_profile_revision%ROWTYPE;
  v_current work.execution_profile_revision%ROWTYPE;
  v_current_revision bigint;
  v_request_hash text;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF NOT EXISTS (
    SELECT 1 FROM work.org
    WHERE id = p_org_id AND status = 'active' AND execution_enabled
      AND NOT operator_suspended
  ) THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
  END IF;
  IF p_profile_id IS NULL OR length(p_profile_id) NOT BETWEEN 1 AND 128
     OR p_profile_id <> btrim(p_profile_id) OR p_revision < 1
     OR p_expected_active_revision IS NULL OR p_expected_active_revision < 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id,
    'execution_profile.activate', p_client_request_id);

  v_request_hash := work.sha256_text(jsonb_build_object(
    'profile_id', p_profile_id, 'revision', p_revision,
    'expected_active_revision', p_expected_active_revision
  )::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'execution_profile.activate'
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_dedup.result_ref::jsonb;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_org_id || ':execution-profile:' || p_profile_id, 0));
  SELECT * INTO v_target FROM work.execution_profile_revision
  WHERE org_id = p_org_id AND profile_id = p_profile_id AND revision = p_revision
  FOR UPDATE;
  IF NOT FOUND OR v_target.status <> 'draft' OR v_target.kind <> 'device_local' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_current FROM work.execution_profile_revision
  WHERE org_id = p_org_id AND profile_id = p_profile_id AND status = 'active'
  FOR UPDATE;
  v_current_revision := CASE WHEN FOUND THEN v_current.revision ELSE NULL END;
  IF p_expected_active_revision = 0 THEN
    IF v_current_revision IS NOT NULL THEN
      RAISE EXCEPTION 'revision_conflict' USING ERRCODE = 'P0001',
        DETAIL = COALESCE(v_current_revision, 0)::text;
    END IF;
  ELSIF v_current_revision IS DISTINCT FROM p_expected_active_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = 'P0001',
      DETAIL = COALESCE(v_current_revision, 0)::text;
  END IF;

  IF v_current_revision IS NOT NULL THEN
    UPDATE work.execution_profile_revision
    SET status = 'revoked', updated_at = now()
    WHERE org_id = p_org_id AND profile_id = p_profile_id AND revision = v_current_revision;
  END IF;
  UPDATE work.execution_profile_revision
  SET status = 'active', updated_at = now()
  WHERE org_id = p_org_id AND profile_id = p_profile_id AND revision = p_revision;

  v_response := jsonb_build_object(
    'profile_id', p_profile_id,
    'revision', p_revision,
    'content_hash', v_target.content_hash,
    'status', 'active',
    'previous_active_revision', v_current_revision
  );
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'execution_profile.activate', p_client_request_id,
     v_request_hash, v_response::text);
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'execution_profile.activate', 'execution_profile',
    p_profile_id,
    jsonb_build_object(
      'revision', p_revision,
      'previous_active_revision', v_current_revision));
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION work.activate_execution_profile(text, text, text, text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.activate_execution_profile(text, text, text, text, bigint, bigint) TO work_api;

RESET ROLE;
