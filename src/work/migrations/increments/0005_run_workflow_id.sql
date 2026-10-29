-- Canonical Run workflow ids (D3): run:<run_id>, derived by the database.
-- p_workflow_id remains in the signatures for wire compatibility but is ignored.
SET ROLE work_owner;

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
     model_route, scope_caps, manifest)
  VALUES
    (new_snapshot_id, p_org_id, new_task_id, 'r0a-v1', p_snapshot_hash,
     p_tool_allowlist, p_model_route, '{}'::jsonb, p_snapshot_manifest);

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

CREATE OR REPLACE FUNCTION work.retry_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_workflow_id text,
  p_runtime_version text
) RETURNS TABLE (run_id uuid, revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  task_row work.task%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  latest_state text;
  req_hash text;
  next_attempt int;
  new_run_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'run.retry', p_client_request_id);
  IF p_runtime_version IS NULL OR p_runtime_version = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(p_task_id::text || ':' || p_expected_revision::text);
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'run.retry' AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted THEN
      RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY SELECT dedup_row.result_ref::uuid, (p_expected_revision + 1);
    RETURN;
  END IF;

  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = p_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.member m
  WHERE m.org_id = p_org_id AND m.subject_id = p_subject_id
    AND m.status = 'active' AND m.work_seat AND m.role <> 'viewer'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = task_row.revision::text;
  END IF;
  IF task_row.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'task_has_active_run' USING ERRCODE = 'P0001';
  END IF;
  SELECT r.state INTO latest_state FROM work.run r
  WHERE r.id = task_row.latest_run_id AND r.org_id = p_org_id
  FOR UPDATE;
  IF task_row.state <> 'open' OR latest_state IS NULL OR latest_state NOT IN ('failed', 'canceled') THEN
    RAISE EXCEPTION 'task_not_runnable' USING ERRCODE = 'P0001';
  END IF;
  IF work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(r.attempt_no), 0) + 1 INTO next_attempt
  FROM work.run r WHERE r.task_id = p_task_id AND r.org_id = p_org_id;
  INSERT INTO work.run
    (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
  VALUES
    (new_run_id, p_org_id, p_task_id, next_attempt, 'queued', task_row.snapshot_id, 'run:' || new_run_id::text, p_runtime_version);
  UPDATE work.task t
  SET active_run_id = new_run_id, latest_run_id = new_run_id,
      revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'run.retry', p_client_request_id, req_hash, p_task_id, 'accepted', new_run_id::text);
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'run.queued',
    jsonb_build_object('run_id', new_run_id, 'attempt_no', next_attempt)
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', new_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'start_workflow', 'run_id', new_run_id, 'workflow_id', 'run:' || new_run_id::text)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'run.retry', 'task', p_task_id::text,
    jsonb_build_object('run_id', new_run_id, 'attempt_no', next_attempt)
  );
  RETURN QUERY SELECT new_run_id, task_row.revision + 1;
END;
$$;

RESET ROLE;
