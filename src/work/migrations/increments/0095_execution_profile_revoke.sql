-- 0095: owner-only ExecutionProfile revocation with binding and operation fencing.
SET ROLE work_owner;

CREATE FUNCTION work.revoke_execution_profile(
  p_org_id text,
  p_actor_subject_id text,
  p_client_request_id text,
  p_profile_id text,
  p_revision bigint,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_dedup work.submission_dedup%ROWTYPE;
  v_target work.execution_profile_revision%ROWTYPE;
  v_request_hash text;
  v_response jsonb;
  v_binding_count bigint := 0;
  v_operation_count bigint := 0;
  v_operation_id uuid;
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
     OR p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id,
    'execution_profile.revoke', p_client_request_id);

  v_request_hash := work.sha256_text(jsonb_build_object(
    'profile_id', p_profile_id, 'revision', p_revision, 'reason', p_reason
  )::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
    AND operation_type = 'execution_profile.revoke'
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
  IF NOT FOUND OR v_target.status <> 'active' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE work.execution_profile_revision
  SET status = 'revoked', updated_at = now()
  WHERE org_id = p_org_id AND profile_id = p_profile_id AND revision = p_revision;

  UPDATE work.device_model_binding
  SET status = 'revoked', revision = revision + 1, updated_at = now()
  WHERE org_id = p_org_id AND profile_id = p_profile_id
    AND profile_revision = p_revision AND status <> 'revoked';
  GET DIAGNOSTICS v_binding_count = ROW_COUNT;

  FOR v_operation_id IN
    SELECT o.id
    FROM work.operation o
    JOIN work.run r ON r.org_id = o.org_id AND r.id = o.run_id
    JOIN work.device_run_binding b
      ON b.org_id = r.org_id AND b.run_id = r.id
     AND b.binding_revision = (
       SELECT MAX(latest.binding_revision)
       FROM work.device_run_binding latest
       WHERE latest.org_id = b.org_id AND latest.run_id = b.run_id
     )
    WHERE o.org_id = p_org_id
      AND b.profile_id = p_profile_id AND b.profile_revision = p_revision
      AND o.state NOT IN ('succeeded', 'failed', 'canceled', 'reconciled', 'unresolved', 'unknown')
  LOOP
    PERFORM work.cancel_operation(p_org_id, v_operation_id, p_actor_subject_id, p_reason);
    v_operation_count := v_operation_count + 1;
  END LOOP;

  v_response := jsonb_build_object(
    'profile_id', p_profile_id,
    'revision', p_revision,
    'content_hash', v_target.content_hash,
    'status', 'revoked',
    'reason', p_reason,
    'revoked_binding_count', v_binding_count,
    'cancel_requested_operation_count', v_operation_count
  );
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'execution_profile.revoke', p_client_request_id,
     v_request_hash, v_response::text);
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'execution_profile.revoke', 'execution_profile',
    p_profile_id,
    jsonb_build_object(
      'revision', p_revision, 'reason', p_reason,
      'revoked_binding_count', v_binding_count,
      'cancel_requested_operation_count', v_operation_count));
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION work.revoke_execution_profile(text, text, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.revoke_execution_profile(text, text, text, text, bigint, text) TO work_api;

RESET ROLE;
