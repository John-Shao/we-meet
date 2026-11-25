-- 0072: authoritative per-step supersede budgets for the owner-facing Work UI.
-- The frozen R0a operations projection exposes logical_key but not supersede_reason;
-- its #n suffix counts every kind of replacement, while J21's five-step budget counts
-- only workspace_rebound and tool_params_changed. Reading #n as the active budget would
-- let passive replacements trigger the sixth-active-supersede exit too early.
SET ROLE work_owner;

CREATE FUNCTION work.run_supersede_budgets(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.assert_session_subject(p_actor_subject_id);

  SELECT * INTO run_row FROM work.run WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task
  WHERE org_id = p_org_id AND id = run_row.task_id
    AND owner_subject_id = p_actor_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'run_id', run_row.id,
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'step_key', budgets.step_key,
        'supersede_no', budgets.supersede_no,
        'active_supersede_count', budgets.active_supersede_count,
        'active_supersede_limit', 5,
        'limit_reached', budgets.active_supersede_count >= 5
      ) ORDER BY budgets.step_key)
      FROM (
        SELECT o.step_key,
               max(o.supersede_no) AS supersede_no,
               count(*) FILTER (
                 WHERE o.supersede_reason IN ('workspace_rebound', 'tool_params_changed')
               )::integer AS active_supersede_count
        FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id
          AND o.step_key IS NOT NULL
        GROUP BY o.step_key
      ) budgets
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION work.run_supersede_budgets(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.run_supersede_budgets(text, uuid, text) TO work_api;

RESET ROLE;
