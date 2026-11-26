SET ROLE work_owner;

CREATE FUNCTION work.local_preview_destination_facts(
  p_org_id text,
  p_actor_subject_id text,
  p_grant_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_count integer;
  v_floor text;
  v_destinations text[];
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_grant_ids IS NULL OR cardinality(p_grant_ids) < 1 OR cardinality(p_grant_ids) > 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT count(*),
         COALESCE((array_agg(g.classification ORDER BY work.classification_rank(g.classification) DESC))[1], 'local_only')
    INTO v_count, v_floor
    FROM work.workspace_grant g
   WHERE g.org_id = p_org_id
     AND g.owner_subject_id = p_actor_subject_id
     AND g.id = ANY(p_grant_ids);
  IF v_count <> cardinality(p_grant_ids) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.allowed_destinations
    INTO v_destinations
    FROM work.local_execution_policy p
   WHERE p.org_id = p_org_id;
  IF v_destinations IS NULL THEN
    v_destinations := ARRAY[]::text[];
  END IF;
  IF v_floor = 'local_only' THEN
    SELECT COALESCE(array_agg(destination), ARRAY[]::text[])
      INTO v_destinations
      FROM unnest(v_destinations) AS destination
     WHERE destination = 'device_local';
  END IF;

  RETURN jsonb_build_object(
    'artifact_classification_floor', v_floor,
    'available_destinations', to_jsonb(v_destinations));
END;
$$;

CREATE FUNCTION work.local_approval_destination_facts(
  p_org_id text,
  p_actor_subject_id text,
  p_approval_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run_id uuid;
  v_taint integer;
  v_destinations text[];
  v_current_action_kind text;
  v_current_classification text;
  v_current_action_taints boolean;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  SELECT o.run_id INTO v_run_id
    FROM work.approval a
    JOIN work.approval_operation ao ON ao.approval_id = a.id AND ao.org_id = a.org_id
    JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
    JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
    JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
   WHERE a.org_id = p_org_id
     AND a.id = p_approval_id
     AND t.owner_subject_id = p_actor_subject_id
     AND t.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT la.action_kind, g.classification
    INTO v_current_action_kind, v_current_classification
    FROM work.approval a
    JOIN work.approval_operation ao ON ao.approval_id = a.id AND ao.org_id = a.org_id
    JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
    JOIN LATERAL (
      SELECT action_kind, grant_id, org_id
        FROM work.local_action
       WHERE org_id = ao.org_id AND operation_id = o.id
       ORDER BY created_at DESC LIMIT 1
    ) la ON true
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
   WHERE a.org_id = p_org_id AND a.id = p_approval_id;
  v_current_action_taints := v_current_action_kind IN ('workspace.read', 'workspace.search', 'artifact.write')
    AND v_current_classification = 'local_only';

  SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0)
    INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
   WHERE la.org_id = p_org_id
     AND o.run_id = v_run_id
     AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');

  SELECT p.allowed_destinations
    INTO v_destinations
    FROM work.local_execution_policy p
   WHERE p.org_id = p_org_id;
  IF v_destinations IS NULL THEN
    v_destinations := ARRAY[]::text[];
  END IF;
  IF v_taint >= work.classification_rank('local_only') THEN
    SELECT COALESCE(array_agg(destination), ARRAY[]::text[])
      INTO v_destinations
      FROM unnest(v_destinations) AS destination
     WHERE destination = 'device_local';
  END IF;

  RETURN jsonb_build_object(
    'local_only_taint', v_taint >= work.classification_rank('local_only'),
    'current_action_taints', v_current_action_taints,
    'available_destinations', to_jsonb(v_destinations));
END;
$$;

REVOKE ALL ON FUNCTION work.local_preview_destination_facts(text, text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.local_approval_destination_facts(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.local_preview_destination_facts(text, text, uuid[]) TO work_api;
GRANT EXECUTE ON FUNCTION work.local_approval_destination_facts(text, text, uuid) TO work_api;

RESET ROLE;
