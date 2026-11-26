-- 0077: owner-scoped readonly scope for the local approval viewer.
-- remember_readonly is legal only for workspace.list/read/search and must reproduce the
-- exact grant, selector and revision that the server approved. The public approval read
-- intentionally exposes only a non-sensitive scope summary, so this getter supplies the
-- closed four-key scope to work_api without granting table access or widening approval.
SET ROLE work_owner;

CREATE FUNCTION work.local_approval_readonly_scope(
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
  v_scope jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  SELECT jsonb_build_object(
           'tool_set', jsonb_build_array(la.action_kind),
           'resource_selector_hash', la.resource_selector_hash,
           'grant_id', la.grant_id,
           'grant_revision', la.grant_revision::text)
    INTO v_scope
  FROM work.approval a
  JOIN work.approval_operation ao ON ao.org_id = a.org_id AND ao.approval_id = a.id
  JOIN work.operation o ON o.org_id = ao.org_id AND o.id = ao.operation_id
  JOIN work.run r ON r.org_id = o.org_id AND r.id = o.run_id
  JOIN work.task t ON t.org_id = r.org_id AND t.id = r.task_id
  JOIN work.local_action la ON la.org_id = o.org_id AND la.operation_id = o.id
  WHERE a.org_id = p_org_id
    AND a.id = p_approval_id
    AND a.status = 'pending'
    AND t.owner_subject_id = p_actor_subject_id
    AND t.deleted_at IS NULL
    AND la.action_kind IN ('workspace.list', 'workspace.read', 'workspace.search')
  ORDER BY la.created_at DESC
  LIMIT 1;
  RETURN v_scope;
END;
$$;

REVOKE ALL ON FUNCTION work.local_approval_readonly_scope(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.local_approval_readonly_scope(text, text, uuid) TO work_api;

RESET ROLE;
