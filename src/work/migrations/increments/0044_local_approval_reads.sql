-- 0044: local approval read face (control-design §1.4 row 66, §1.2 ApprovalV2).
--
-- M1a/M1b landed decide_local_approval (0042) but no read path: the task page cannot
-- show a pending local approval, and the decision endpoint has no way to fetch the
-- params_hash/revision/epochs the ApprovalDecisionProof must bind. This increment adds
-- the two owner-scoped definer reads that close that gap. No table privilege is granted
-- (0024 house rule); work_api reaches the rows only through these SECURITY DEFINER
-- functions, exactly like list_devices / list_readonly_grants.
--
-- Only LOCAL approvals are visible here: an approval joins through approval_operation →
-- operation → local_action, so an R0a cloud approval (no local_action row) never appears
-- on the v2 face. The DTO carries no full local path or params — scope_summary is the
-- server-held summary, local_detail_ref is an opaque ref the original device resolves.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- list_local_approvals: one signed keyset page of the caller's local approvals.
-- Cursor shape mirrors list_devices: sha256(org|subject|scope|ts_millis|id)|ts|id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.list_local_approvals(
  p_org_id text,
  p_actor_subject_id text,
  p_status text,
  p_cursor text,
  p_limit int
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_limit int := COALESCE(p_limit, 50);
  v_after_ts timestamptz;
  v_after_id uuid;
  v_parts text[];
  v_rows jsonb;
  v_count int;
  v_last_created timestamptz;
  v_last_id uuid;
  v_next text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF v_limit < 1 OR v_limit > 100 THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN
     ('pending', 'approved', 'rejected', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    v_parts := string_to_array(p_cursor, '|');
    IF cardinality(v_parts) <> 3
       OR v_parts[1] IS DISTINCT FROM work.sha256_text(
            p_org_id || '|' || p_actor_subject_id || '|approval.list|'
            || v_parts[2] || '|' || v_parts[3]) THEN
      RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
    END IF;
    v_after_ts := to_timestamp(v_parts[2]::double precision / 1000);
    v_after_id := v_parts[3]::uuid;
  END IF;

  SELECT jsonb_agg(x ORDER BY created_at DESC, id DESC), count(*)
    INTO v_rows, v_count
    FROM (
      SELECT a.id, a.created_at,
             jsonb_build_object(
               'id', a.id, 'task_id', t.id, 'run_id', r.id,
               'operation_id', ctx.operation_id, 'params_hash', a.params_hash,
               'action_kind', ctx.action_kind, 'risk', a.risk,
               'scope_summary', a.scope, 'local_detail_ref', ctx.local_payload_ref,
               'device_id', wg.device_id, 'policy_epoch', a.policy_epoch,
               'access_epoch', r.admission_access_epoch,
               'grant_revision', ctx.grant_revision, 'expires_at', a.expires_at,
               'revision', a.revision, 'status', a.status,
               'allowed_decisions',
                 CASE WHEN a.status = 'pending'
                      THEN jsonb_build_array('approved', 'rejected')
                      ELSE '[]'::jsonb END,
               'created_at', a.created_at, 'updated_at', a.updated_at) AS x
        FROM work.approval a
        JOIN LATERAL (
          SELECT o.id AS operation_id, o.run_id,
                 la.action_kind, la.local_payload_ref, la.grant_id, la.grant_revision
            FROM work.approval_operation ao
            JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
            JOIN LATERAL (
              SELECT action_kind, local_payload_ref, grant_id, grant_revision
                FROM work.local_action
               WHERE org_id = ao.org_id AND operation_id = o.id
               ORDER BY created_at DESC LIMIT 1
            ) la ON true
           WHERE ao.approval_id = a.id AND ao.org_id = a.org_id
           ORDER BY o.id LIMIT 1
        ) ctx ON true
        JOIN work.run r ON r.id = ctx.run_id AND r.org_id = a.org_id
        JOIN work.task t ON t.id = r.task_id AND t.org_id = a.org_id
        JOIN work.workspace_grant wg ON wg.id = ctx.grant_id AND wg.org_id = a.org_id
       WHERE a.org_id = p_org_id
         AND t.owner_subject_id = p_actor_subject_id
         AND t.deleted_at IS NULL
         AND (p_status IS NULL OR a.status = p_status)
         AND (v_after_ts IS NULL OR (a.created_at, a.id) < (v_after_ts, v_after_id))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT v_limit + 1
    ) s;

  v_next := NULL;
  IF v_count > v_limit THEN
    -- Trim the lookahead row and sign the cursor of the last kept row.
    SELECT elem ->> 'created_at', (elem ->> 'id')::uuid
      INTO v_last_created, v_last_id
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS e(elem, ord)
     WHERE ord = v_limit;
    v_rows := (SELECT jsonb_agg(elem ORDER BY ord)
                 FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS e(elem, ord)
                WHERE ord <= v_limit);
    v_next := work.sha256_text(
                p_org_id || '|' || p_actor_subject_id || '|approval.list|'
                || (extract(epoch FROM v_last_created) * 1000)::bigint::text
                || '|' || v_last_id::text)
              || '|' || (extract(epoch FROM v_last_created) * 1000)::bigint::text
              || '|' || v_last_id::text;
  END IF;

  RETURN jsonb_build_object('approvals', COALESCE(v_rows, '[]'::jsonb),
    'next_cursor', v_next);
END;
$$;

-- ---------------------------------------------------------------------------
-- get_local_approval: one ApprovalV2 by id, owner-scoped. A non-owner or absent
-- approval is approval_not_found (the same shape decide_local_approval uses), so
-- the face never confirms another owner's approval exists.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.get_local_approval(
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
  v_item jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  SELECT jsonb_build_object(
           'id', a.id, 'task_id', t.id, 'run_id', r.id,
           'operation_id', ctx.operation_id, 'params_hash', a.params_hash,
           'action_kind', ctx.action_kind, 'risk', a.risk,
           'scope_summary', a.scope, 'local_detail_ref', ctx.local_payload_ref,
           'device_id', wg.device_id, 'policy_epoch', a.policy_epoch,
           'access_epoch', r.admission_access_epoch,
           'grant_revision', ctx.grant_revision, 'expires_at', a.expires_at,
           'revision', a.revision, 'status', a.status,
           'allowed_decisions',
             CASE WHEN a.status = 'pending'
                  THEN jsonb_build_array('approved', 'rejected')
                  ELSE '[]'::jsonb END,
           'created_at', a.created_at, 'updated_at', a.updated_at)
    INTO v_item
    FROM work.approval a
    JOIN LATERAL (
      SELECT o.id AS operation_id, o.run_id,
             la.action_kind, la.local_payload_ref, la.grant_id, la.grant_revision
        FROM work.approval_operation ao
        JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
        JOIN LATERAL (
          SELECT action_kind, local_payload_ref, grant_id, grant_revision
            FROM work.local_action
           WHERE org_id = ao.org_id AND operation_id = o.id
           ORDER BY created_at DESC LIMIT 1
        ) la ON true
       WHERE ao.approval_id = a.id AND ao.org_id = a.org_id
       ORDER BY o.id LIMIT 1
    ) ctx ON true
    JOIN work.run r ON r.id = ctx.run_id AND r.org_id = a.org_id
    JOIN work.task t ON t.id = r.task_id AND t.org_id = a.org_id
    JOIN work.workspace_grant wg ON wg.id = ctx.grant_id AND wg.org_id = a.org_id
   WHERE a.org_id = p_org_id AND a.id = p_approval_id
     AND t.owner_subject_id = p_actor_subject_id
     AND t.deleted_at IS NULL;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION work.list_local_approvals(text, text, text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.get_local_approval(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_local_approvals(text, text, text, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_local_approval(text, text, uuid) TO work_api;

RESET ROLE;