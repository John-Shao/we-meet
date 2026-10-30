-- 0015: Snapshot revision for the closed TaskDetail.snapshot shape.
--
-- Authority: D2 §8.2 closed snapshot object and the 2026-10-30 decision B1.
-- Every capability snapshot gets a per-task monotonic revision; existing rows
-- are backfilled in creation order. submit_task assigns the next revision in the
-- same transaction that creates the task and its first snapshot.
SET ROLE work_owner;

ALTER TABLE work.capability_snapshot ADD COLUMN revision bigint;

-- capability_snapshot has FORCE RLS; the owner backfill runs without a tenant
-- context, so force is suspended for the duration and restored immediately.
ALTER TABLE work.capability_snapshot NO FORCE ROW LEVEL SECURITY;
UPDATE work.capability_snapshot c
SET revision = ranked.rn
FROM (
  SELECT id,
         row_number() OVER (PARTITION BY org_id, task_id ORDER BY created_at, id) AS rn
  FROM work.capability_snapshot
) ranked
WHERE c.id = ranked.id;
ALTER TABLE work.capability_snapshot FORCE ROW LEVEL SECURITY;

ALTER TABLE work.capability_snapshot ALTER COLUMN revision SET NOT NULL;
ALTER TABLE work.capability_snapshot ALTER COLUMN revision SET DEFAULT 1;
ALTER TABLE work.capability_snapshot
  ADD CONSTRAINT capability_snapshot_revision_check CHECK (revision >= 1);
CREATE UNIQUE INDEX capability_snapshot_task_revision_idx
  ON work.capability_snapshot (org_id, task_id, revision);

CREATE OR REPLACE FUNCTION work.submit_task(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_input_id uuid,
  p_title text,
  p_permission_mode text,
  p_snapshot_hash text,
  p_snapshot_manifest jsonb,
  p_tool_allowlist text[],
  p_model_route jsonb,
  p_workflow_id text,
  p_runtime_version text
) RETURNS TABLE (task_id uuid, run_id uuid, revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  org_row work.org%ROWTYPE;
  member_row work.member%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  input_row work.input_object%ROWTYPE;
  req_hash text;
  new_task_id uuid := gen_random_uuid();
  new_snapshot_id uuid := gen_random_uuid();
  new_run_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'task.submit', p_client_request_id);
  req_hash := work.sha256_text(jsonb_build_object(
    'input_id', p_input_id, 'title', p_title, 'permission_mode', p_permission_mode,
    'snapshot_hash', p_snapshot_hash, 'tool_allowlist', to_jsonb(p_tool_allowlist),
    'model_route', p_model_route
  )::text);

  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id
    AND d.subject_id = p_subject_id
    AND d.operation_type = 'task.submit'
    AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted OR dedup_row.task_id IS NULL THEN
      RAISE EXCEPTION 'task_deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
      SELECT t.id, r.id, t.revision
      FROM work.task t
      JOIN work.run r
        ON r.task_id = t.id AND r.org_id = t.org_id AND r.attempt_no = 1
      WHERE t.id = dedup_row.task_id AND t.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dedup_task_missing' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;

  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'title_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_permission_mode NOT IN ('ask_each', 'auto_readonly') THEN
    RAISE EXCEPTION 'permission_mode_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF p_tool_allowlist IS NULL
     OR NOT (p_tool_allowlist <@ ARRAY['model_call', 'read_builtin_template', 'write_artifact_draft']::text[])
     OR NOT ('model_call' = ANY (p_tool_allowlist)) THEN
    RAISE EXCEPTION 'scope_unavailable:tool_allowlist' USING ERRCODE = 'P0001';
  END IF;
  IF p_snapshot_hash IS NULL OR p_snapshot_hash = ''
     OR p_snapshot_manifest IS NULL
     OR p_model_route IS NULL
     OR p_runtime_version IS NULL OR p_runtime_version = '' THEN
    RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO org_row
  FROM work.org
  WHERE id = p_org_id
  FOR SHARE;
  IF NOT FOUND
     OR org_row.status <> 'active'
     OR NOT org_row.execution_enabled
     OR org_row.operator_suspended THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO member_row
  FROM work.member
  WHERE org_id = p_org_id AND subject_id = p_subject_id
  FOR SHARE;
  IF NOT FOUND
     OR member_row.status <> 'active'
     OR NOT member_row.work_seat
     OR member_row.role = 'viewer' THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO policy_row
  FROM work.org_policy
  WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  IF policy_row.force_ask_each AND p_permission_mode <> 'ask_each' THEN
    RAISE EXCEPTION 'permission_mode_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF p_permission_mode = 'auto_readonly' AND NOT policy_row.allow_auto_readonly THEN
    RAISE EXCEPTION 'permission_mode_unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO input_row
  FROM work.input_object i
  WHERE i.id = p_input_id
    AND i.org_id = p_org_id
    AND i.subject_id = p_subject_id
    AND i.status = 'active'
    AND i.task_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'input_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO work.task
    (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
  VALUES
    (new_task_id, p_org_id, p_subject_id, 'open', p_permission_mode, btrim(p_title), p_input_id, 0);

  UPDATE work.input_object i
  SET task_id = new_task_id
  WHERE i.id = p_input_id AND i.org_id = p_org_id;

  INSERT INTO work.capability_snapshot
    (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
     model_route, scope_caps, manifest, revision)
  VALUES
    (new_snapshot_id, p_org_id, new_task_id, 'r0a-v1', p_snapshot_hash,
     p_tool_allowlist, p_model_route, '{}'::jsonb, p_snapshot_manifest,
     (SELECT COALESCE(MAX(c.revision), 0) + 1
      FROM work.capability_snapshot c
      WHERE c.org_id = p_org_id AND c.task_id = new_task_id));

  UPDATE work.task t
  SET snapshot_id = new_snapshot_id
  WHERE t.id = new_task_id AND t.org_id = p_org_id;

  INSERT INTO work.run
    (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
  VALUES
    (new_run_id, p_org_id, new_task_id, 1, 'queued', new_snapshot_id, 'run:' || new_run_id::text, p_runtime_version);

  UPDATE work.task AS t
  SET active_run_id = new_run_id,
      latest_run_id = new_run_id,
      revision = t.revision + 1,
      updated_at = now()
  WHERE t.id = new_task_id AND t.org_id = p_org_id;

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'task.submit', p_client_request_id, req_hash, new_task_id, 'accepted', new_run_id::text);

  PERFORM work.append_task_event(
    p_org_id, new_task_id, 'task.submitted',
    jsonb_build_object(
      'task_id', new_task_id,
      'run_id', new_run_id,
      'state', 'open',
      'permission_mode', p_permission_mode
    )
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', new_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'start_workflow', 'run_id', new_run_id, 'workflow_id', 'run:' || new_run_id::text)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'task.submit', 'task', new_task_id::text,
    jsonb_build_object(
      'run_id', new_run_id,
      'permission_mode', p_permission_mode,
      'snapshot_hash', p_snapshot_hash
    )
  );
  RETURN QUERY SELECT new_task_id, new_run_id, 1::bigint;
END;
$$;
