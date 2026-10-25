-- R0a 领域命令：输入、提交、成果发布、取消、审批、Outbox
-- 这些函数在装配后统一改为 SECURITY DEFINER，由 work_owner 拥有；
-- 应用角色只获得具体函数的 EXECUTE，不获得事实/账本表的直接 DML。

-- Outbox：单聚合有序 + 失败退避 + 死信（D3 §15-6 闭合）
ALTER TABLE work.outbox
  ADD COLUMN outbox_seq bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN last_error_code text,
  ADD COLUMN dead_lettered_at timestamptz;

CREATE UNIQUE INDEX work_outbox_seq ON work.outbox(outbox_seq);
CREATE INDEX work_outbox_aggregate_pending
  ON work.outbox(aggregate_type, aggregate_id, outbox_seq)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

CREATE FUNCTION work.append_audit(
  p_org_id text,
  p_actor_subject_id text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  audit_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO work.audit_event
    (id, org_id, actor_subject_id, action, target_type, target_id, metadata)
  VALUES
    (audit_id, p_org_id, p_actor_subject_id, p_action, p_target_type, p_target_id,
     COALESCE(p_metadata, '{}'::jsonb));
  RETURN audit_id;
END;
$$;

CREATE FUNCTION work.append_task_event(
  p_org_id text,
  p_task_id uuid,
  p_type text,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  next_seq bigint;
  event_id uuid := gen_random_uuid();
BEGIN
  PERFORM 1 FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(MAX(seq), 0) + 1 INTO next_seq
  FROM work.task_event
  WHERE task_id = p_task_id AND org_id = p_org_id;
  INSERT INTO work.task_event
    (id, org_id, task_id, seq, type, payload)
  VALUES
    (event_id, p_org_id, p_task_id, next_seq, p_type, COALESCE(p_payload, '{}'::jsonb));
  INSERT INTO work.outbox
    (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES
    (p_org_id, 'task', p_task_id, event_id, COALESCE(p_payload, '{}'::jsonb));
  RETURN event_id;
END;
$$;

CREATE FUNCTION work.create_input(
  p_org_id text,
  p_subject_id text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text DEFAULT 'application/json'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  input_id uuid;
BEGIN
  PERFORM 1 FROM work.member
  WHERE org_id = p_org_id
    AND subject_id = p_subject_id
    AND status = 'active'
    AND work_seat = true
    AND role <> 'viewer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_content_ref IS NULL OR p_content_ref = ''
     OR p_content_hash IS NULL OR p_content_hash = ''
     OR p_bytes IS NULL OR p_bytes <= 0
     OR p_media_type IS NULL OR p_media_type = '' THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO work.input_object
    (org_id, subject_id, purpose, content_ref, content_hash, bytes, media_type)
  VALUES
    (p_org_id, p_subject_id, 'task_input', p_content_ref, p_content_hash, p_bytes, p_media_type)
  ON CONFLICT (org_id, subject_id, content_hash, purpose) WHERE status = 'active'
  DO NOTHING
  RETURNING id INTO input_id;
  IF input_id IS NULL THEN
    SELECT id INTO input_id
    FROM work.input_object
    WHERE org_id = p_org_id
      AND subject_id = p_subject_id
      AND content_hash = p_content_hash
      AND purpose = 'task_input'
      AND status = 'active';
  END IF;
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'input.create', 'input', input_id::text,
    jsonb_build_object('bytes', p_bytes, 'media_type', p_media_type)
  );
  RETURN input_id;
END;
$$;

CREATE FUNCTION work.submit_task(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_request_hash text,
  p_input_id uuid,
  p_title text,
  p_permission_mode text,
  p_snapshot_hash text,
  p_snapshot_manifest jsonb,
  p_tool_allowlist text[],
  p_model_route jsonb,
  p_price_version text,
  p_workflow_id text,
  p_runtime_version text
) RETURNS TABLE (task_id uuid, run_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  org_row work.org%ROWTYPE;
  member_row work.member%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  input_row work.input_object%ROWTYPE;
  new_task_id uuid := gen_random_uuid();
  new_snapshot_id uuid := gen_random_uuid();
  new_run_id uuid := gen_random_uuid();
BEGIN
  IF p_client_request_id IS NULL OR length(p_client_request_id) < 8 THEN
    RAISE EXCEPTION 'invalid_client_request_id' USING ERRCODE = '22023';
  END IF;
  IF p_request_hash IS NULL OR p_request_hash = '' THEN
    RAISE EXCEPTION 'invalid_request_hash' USING ERRCODE = '22023';
  END IF;
  IF p_title IS NULL OR length(p_title) < 1 OR length(p_title) > 200 THEN
    RAISE EXCEPTION 'invalid_title' USING ERRCODE = '22023';
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
     OR p_price_version IS NULL OR p_price_version = ''
     OR p_workflow_id IS NULL OR p_workflow_id = ''
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
  FROM work.input_object
  WHERE id = p_input_id
    AND org_id = p_org_id
    AND subject_id = p_subject_id
    AND status = 'active'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'input_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO dedup_row
  FROM work.submission_dedup
  WHERE org_id = p_org_id
    AND subject_id = p_subject_id
    AND operation_type = 'task.submit'
    AND client_request_id = p_client_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF dedup_row.request_hash <> p_request_hash THEN
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

  INSERT INTO work.task
    (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
  VALUES
    (new_task_id, p_org_id, p_subject_id, 'open', p_permission_mode, p_title, p_input_id, 0);

  INSERT INTO work.capability_snapshot
    (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
     model_route, scope_caps, price_version, manifest)
  VALUES
    (new_snapshot_id, p_org_id, new_task_id, 'r0a-v1', p_snapshot_hash,
     p_tool_allowlist, p_model_route, '{}'::jsonb, p_price_version, p_snapshot_manifest);

  UPDATE work.task
  SET snapshot_id = new_snapshot_id
  WHERE id = new_task_id AND org_id = p_org_id;

  INSERT INTO work.run
    (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
  VALUES
    (new_run_id, p_org_id, new_task_id, 1, 'queued', new_snapshot_id, p_workflow_id, p_runtime_version);

  UPDATE work.task AS t
  SET active_run_id = new_run_id,
      latest_run_id = new_run_id,
      revision = t.revision + 1,
      updated_at = now()
  WHERE t.id = new_task_id AND t.org_id = p_org_id;

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state)
  VALUES
    (p_org_id, p_subject_id, 'task.submit', p_client_request_id, p_request_hash, new_task_id, 'accepted');

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
    jsonb_build_object('kind', 'start_workflow', 'run_id', new_run_id, 'workflow_id', p_workflow_id)
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

CREATE FUNCTION work.publish_artifact(
  p_org_id text,
  p_task_id uuid,
  p_run_id uuid,
  p_logical_name text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text,
  p_provenance jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (artifact_id uuid, version_no int)
LANGUAGE plpgsql AS $$
DECLARE
  artifact_row work.artifact%ROWTYPE;
  next_version int;
  new_artifact_id uuid := gen_random_uuid();
BEGIN
  IF p_logical_name IS NULL OR p_logical_name = ''
     OR p_content_ref IS NULL OR p_content_ref = ''
     OR p_content_hash IS NULL OR p_content_hash = ''
     OR p_bytes IS NULL OR p_bytes < 0
     OR p_media_type IS NULL OR p_media_type = '' THEN
    RAISE EXCEPTION 'invalid_artifact' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM work.task t
  JOIN work.run r
    ON r.task_id = t.id AND r.org_id = t.org_id
  WHERE t.id = p_task_id
    AND t.org_id = p_org_id
    AND r.id = p_run_id
    AND r.org_id = p_org_id
    AND r.state IN ('active', 'waiting')
  FOR UPDATE OF t, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_accepting_artifacts' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO artifact_row
  FROM work.artifact
  WHERE org_id = p_org_id AND task_id = p_task_id AND logical_name = p_logical_name
  FOR UPDATE;
  IF FOUND THEN
    IF artifact_row.state = 'deleted' THEN
      RAISE EXCEPTION 'artifact_deleted' USING ERRCODE = 'P0001';
    END IF;
    new_artifact_id := artifact_row.id;
  ELSE
    INSERT INTO work.artifact
      (id, org_id, task_id, logical_name, state)
    VALUES
      (new_artifact_id, p_org_id, p_task_id, p_logical_name, 'draft');
  END IF;
  SELECT COALESCE(MAX(av.version_no), 0) + 1 INTO next_version
  FROM work.artifact_version av
  WHERE av.artifact_id = new_artifact_id AND av.org_id = p_org_id;
  INSERT INTO work.artifact_version
    (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type, state, provenance)
  VALUES
    (new_artifact_id, p_org_id, next_version, p_content_ref, p_content_hash,
     p_bytes, p_media_type, 'staged', COALESCE(p_provenance, '{}'::jsonb));
  UPDATE work.artifact_version AS av
  SET state = 'published', published_at = now()
  WHERE av.artifact_id = new_artifact_id AND av.org_id = p_org_id AND av.version_no = next_version;
  UPDATE work.artifact
  SET state = 'published', revision = revision + 1, updated_at = now()
  WHERE id = new_artifact_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'artifact.published',
    jsonb_build_object(
      'artifact_id', new_artifact_id,
      'version_no', next_version,
      'content_hash', p_content_hash,
      'bytes', p_bytes,
      'media_type', p_media_type
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'artifact.publish', 'artifact', new_artifact_id::text,
    jsonb_build_object('task_id', p_task_id, 'run_id', p_run_id, 'version_no', next_version)
  );
  RETURN QUERY SELECT new_artifact_id, next_version;
END;
$$;

CREATE FUNCTION work.request_cancel(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  task_id uuid;
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row
  FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO run_row
  FROM work.run
  WHERE id = p_run_id AND org_id = p_org_id
  FOR UPDATE;
  IF run_row.state IN ('succeeded', 'failed', 'canceled', 'cancel_requested') THEN
    RETURN;
  END IF;
  UPDATE work.run
  SET state = 'cancel_requested',
      wait_reason = NULL,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'run.cancel_requested',
    jsonb_build_object('run_id', p_run_id, 'reason', p_reason)
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', p_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'cancel_signal', 'run_id', p_run_id, 'reason', p_reason)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'run.cancel_request', 'run', p_run_id::text,
    jsonb_build_object('task_id', task_id, 'reason', p_reason)
  );
END;
$$;

CREATE FUNCTION work.authorize_operation(
  p_org_id text,
  p_operation_id uuid,
  p_policy_epoch bigint,
  p_decision_source text DEFAULT 'policy_auto'
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
BEGIN
  IF p_decision_source <> 'policy_auto' THEN
    RAISE EXCEPTION 'invalid_decision_source' USING ERRCODE = '22023';
  END IF;
  IF p_policy_epoch IS NULL OR p_policy_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid_policy_epoch' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'waiting_approval' THEN
    RAISE EXCEPTION 'approval_required' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state <> 'prepared' THEN
    RAISE EXCEPTION 'operation_not_authorizable' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.operation
  SET state = 'authorized',
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.authorized',
    jsonb_build_object(
      'operation_id', p_operation_id,
      'decision_source', p_decision_source,
      'policy_epoch', p_policy_epoch
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.authorize', 'operation', p_operation_id::text,
    jsonb_build_object('policy_epoch', p_policy_epoch, 'decision_source', p_decision_source)
  );
END;
$$;

CREATE FUNCTION work.finish_operation(
  p_org_id text,
  p_operation_id uuid,
  p_outcome text,
  p_provider_request_id text DEFAULT NULL,
  p_receipt_ref text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid_operation_outcome' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state <> 'dispatching' THEN
    RAISE EXCEPTION 'operation_not_dispatching' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.operation
  SET state = p_outcome,
      provider_request_id = p_provider_request_id,
      receipt_ref = p_receipt_ref,
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.finished',
    jsonb_build_object(
      'operation_id', p_operation_id,
      'outcome', p_outcome,
      'provider_request_id', p_provider_request_id
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.finish', 'operation', p_operation_id::text,
    jsonb_build_object('outcome', p_outcome, 'provider_request_id', p_provider_request_id)
  );
END;
$$;

CREATE FUNCTION work.cancel_operation(
  p_org_id text,
  p_operation_id uuid,
  p_actor_subject_id text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  reservation_id uuid;
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state IN ('succeeded', 'failed', 'canceled', 'reconciled', 'unresolved') THEN
    RETURN;
  END IF;
  IF operation_row.state = 'dispatching' THEN
    UPDATE work.operation
    SET state = 'unknown',
        revision = revision + 1,
        updated_at = now()
    WHERE id = p_operation_id AND org_id = p_org_id;
    PERFORM work.append_task_event(
      p_org_id, task_id, 'operation.unknown',
      jsonb_build_object('operation_id', p_operation_id, 'reason', p_reason)
    );
    PERFORM work.append_audit(
      p_org_id, p_actor_subject_id, 'operation.unknown', 'operation', p_operation_id::text,
      jsonb_build_object('reason', p_reason)
    );
    RETURN;
  END IF;
  IF operation_row.state IN ('prepared', 'waiting_approval', 'authorized') THEN
    UPDATE work.operation
    SET state = 'canceled',
        revision = revision + 1,
        updated_at = now()
    WHERE id = p_operation_id AND org_id = p_org_id;
    SELECT id INTO reservation_id
    FROM work.budget_reservation
    WHERE operation_id = p_operation_id AND state = 'held';
    IF reservation_id IS NOT NULL THEN
      PERFORM work.release_budget(reservation_id);
    END IF;
    PERFORM work.append_task_event(
      p_org_id, task_id, 'operation.canceled',
      jsonb_build_object('operation_id', p_operation_id, 'reason', p_reason)
    );
    PERFORM work.append_audit(
      p_org_id, p_actor_subject_id, 'operation.cancel', 'operation', p_operation_id::text,
      jsonb_build_object('reason', p_reason)
    );
    RETURN;
  END IF;
  RETURN;
END;
$$;


CREATE FUNCTION work.wait_run(
  p_org_id text,
  p_run_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  task_row work.task%ROWTYPE;
  run_row work.run%ROWTYPE;
BEGIN
  IF p_reason NOT IN ('budget', 'provider', 'reconcile') THEN
    RAISE EXCEPTION 'invalid_wait_reason' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row
  FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO run_row
  FROM work.run
  WHERE id = p_run_id AND org_id = p_org_id
  FOR UPDATE;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state = 'waiting' THEN
    IF run_row.wait_reason IS DISTINCT FROM p_reason THEN
      UPDATE work.run
      SET wait_reason = p_reason,
          control_revision = control_revision + 1,
          updated_at = now()
      WHERE id = p_run_id AND org_id = p_org_id;
      PERFORM work.append_task_event(
        p_org_id, task_id, 'run.waiting',
        jsonb_build_object('run_id', p_run_id, 'reason', p_reason)
      );
    END IF;
    RETURN;
  END IF;
  IF run_row.state <> 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run
  SET state = 'waiting',
      wait_reason = p_reason,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'run.waiting',
    jsonb_build_object('run_id', p_run_id, 'reason', p_reason)
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'run.wait', 'run', p_run_id::text,
    jsonb_build_object('task_id', task_id, 'reason', p_reason)
  );
END;
$$;

CREATE FUNCTION work.resume_run(
  p_org_id text,
  p_run_id uuid
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  task_row work.task%ROWTYPE;
  run_row work.run%ROWTYPE;
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row
  FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO run_row
  FROM work.run
  WHERE id = p_run_id AND org_id = p_org_id
  FOR UPDATE;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state = 'active' THEN
    RETURN;
  END IF;
  IF run_row.state <> 'waiting' THEN
    RAISE EXCEPTION 'run_not_waiting' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run
  SET state = 'active',
      wait_reason = NULL,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'run.resumed',
    jsonb_build_object('run_id', p_run_id)
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'run.resume', 'run', p_run_id::text,
    jsonb_build_object('task_id', task_id)
  );
END;
$$;

CREATE FUNCTION work.mark_operation_unknown(
  p_org_id text,
  p_operation_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'unknown' THEN
    RETURN;
  END IF;
  IF operation_row.state <> 'dispatching' THEN
    RAISE EXCEPTION 'operation_not_dispatching' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.operation
  SET state = 'unknown',
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.unknown',
    jsonb_build_object('operation_id', p_operation_id, 'reason', p_reason)
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.unknown', 'operation', p_operation_id::text,
    jsonb_build_object('task_id', task_id, 'reason', p_reason)
  );
END;
$$;

CREATE FUNCTION work.reconcile_operation(
  p_org_id text,
  p_operation_id uuid,
  p_resolution text,
  p_provider_request_id text DEFAULT NULL,
  p_billable_cents bigint DEFAULT 0,
  p_price_version text DEFAULT 'price-v1',
  p_evidence_ref text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  reservation work.budget_reservation%ROWTYPE;
  next_revision int;
BEGIN
  IF p_resolution NOT IN ('sent_succeeded', 'not_sent', 'unresolved') THEN
    RAISE EXCEPTION 'invalid_reconciliation_resolution' USING ERRCODE = '22023';
  END IF;
  IF p_billable_cents < 0 THEN
    RAISE EXCEPTION 'invalid_billable_amount' USING ERRCODE = '22023';
  END IF;
  IF p_resolution IN ('sent_succeeded', 'not_sent')
     AND (p_evidence_ref IS NULL OR p_evidence_ref = '') THEN
    RAISE EXCEPTION 'reconciliation_evidence_required' USING ERRCODE = '22023';
  END IF;
  IF p_price_version IS NULL OR p_price_version = '' THEN
    RAISE EXCEPTION 'invalid_price_version' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'reconciled' THEN
    RETURN;
  END IF;
  IF operation_row.state = 'unresolved' AND p_resolution = 'unresolved' THEN
    RETURN;
  END IF;
  IF operation_row.state NOT IN ('unknown', 'unresolved') THEN
    RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO reservation
  FROM work.budget_reservation
  WHERE operation_id = p_operation_id AND org_id = p_org_id
  ORDER BY reservation_seq DESC
  LIMIT 1
  FOR UPDATE;
  IF p_resolution = 'sent_succeeded' THEN
    IF reservation.id IS NULL THEN
      RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF p_billable_cents > reservation.amount_cents THEN
      RAISE EXCEPTION 'settlement_out_of_bounds' USING ERRCODE = '22023';
    END IF;
    next_revision := reservation.settlement_revision + 1;
    PERFORM work.settle_budget(
      reservation.id, p_billable_cents, p_price_version,
      jsonb_build_object('resolution', p_resolution, 'evidence_ref', p_evidence_ref),
      next_revision
    );
  ELSIF p_resolution = 'not_sent' THEN
    IF reservation.id IS NOT NULL AND reservation.state = 'held' THEN
      PERFORM work.release_budget(reservation.id);
    ELSIF reservation.id IS NOT NULL AND reservation.state = 'unknown' THEN
      next_revision := reservation.settlement_revision + 1;
      PERFORM work.settle_budget(
        reservation.id, 0, p_price_version,
        jsonb_build_object('resolution', p_resolution, 'evidence_ref', p_evidence_ref),
        next_revision
      );
    END IF;
  END IF;
  UPDATE work.operation
  SET state = CASE WHEN p_resolution = 'unresolved' THEN 'unresolved' ELSE 'reconciled' END,
      provider_request_id = COALESCE(p_provider_request_id, provider_request_id),
      receipt_ref = COALESCE(p_evidence_ref, receipt_ref),
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id,
    CASE WHEN p_resolution = 'unresolved' THEN 'operation.unresolved' ELSE 'operation.reconciled' END,
    jsonb_build_object(
      'operation_id', p_operation_id,
      'resolution', p_resolution,
      'billable_cents', p_billable_cents,
      'evidence_ref', p_evidence_ref
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL,
    CASE WHEN p_resolution = 'unresolved' THEN 'operation.unresolved' ELSE 'operation.reconcile' END,
    'operation', p_operation_id::text,
    jsonb_build_object('resolution', p_resolution, 'billable_cents', p_billable_cents, 'evidence_ref', p_evidence_ref)
  );
END;
$$;

CREATE FUNCTION work.request_approval(
  p_org_id text,
  p_operation_id uuid,
  p_params_hash text,
  p_scope jsonb,
  p_risk text,
  p_expires_at timestamptz,
  p_policy_epoch bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  approval_id uuid := gen_random_uuid();
  existing_id uuid;
BEGIN
  IF p_params_hash IS NULL OR p_params_hash = ''
     OR p_scope IS NULL
     OR p_risk NOT IN ('low', 'medium', 'high')
     OR p_expires_at IS NULL OR p_expires_at <= now()
     OR p_policy_epoch IS NULL OR p_policy_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid_approval_request' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'waiting_approval' THEN
    SELECT approval_id INTO existing_id
    FROM work.approval_operation
    WHERE operation_id = p_operation_id AND org_id = p_org_id;
    IF existing_id IS NOT NULL THEN
      RETURN existing_id;
    END IF;
  END IF;
  IF operation_row.state <> 'prepared' THEN
    RAISE EXCEPTION 'operation_not_approvable' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO work.approval
    (id, org_id, target_type, params_hash, scope, risk, expires_at, policy_epoch, status)
  VALUES
    (approval_id, p_org_id, 'operation', p_params_hash, p_scope, p_risk,
     p_expires_at, p_policy_epoch, 'pending');
  INSERT INTO work.approval_operation
    (approval_id, operation_id, org_id)
  VALUES
    (approval_id, p_operation_id, p_org_id);
  UPDATE work.operation
  SET state = 'waiting_approval',
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'approval.requested',
    jsonb_build_object(
      'approval_id', approval_id,
      'operation_id', p_operation_id,
      'risk', p_risk,
      'expires_at', p_expires_at
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'approval.request', 'approval', approval_id::text,
    jsonb_build_object('operation_id', p_operation_id, 'risk', p_risk)
  );
  RETURN approval_id;
END;
$$;

CREATE FUNCTION work.decide_approval(
  p_org_id text,
  p_approval_id uuid,
  p_actor_subject_id text,
  p_decision text,
  p_expected_revision bigint,
  p_params_hash text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  approval_row work.approval%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  task_id uuid;
  existing_decision work.approval_decision%ROWTYPE;
  reservation_id uuid;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_approval_decision' USING ERRCODE = '22023';
  END IF;
  SELECT o.id, r.task_id INTO operation_row.id, task_id
  FROM work.approval_operation ao
  JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE ao.approval_id = p_approval_id AND ao.org_id = p_org_id;
  IF operation_row.id IS NULL THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = operation_row.id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO approval_row
  FROM work.approval
  WHERE id = p_approval_id AND org_id = p_org_id
  FOR UPDATE;
  IF approval_row.status <> 'pending' THEN
    SELECT * INTO existing_decision
    FROM work.approval_decision
    WHERE approval_id = p_approval_id AND org_id = p_org_id;
    IF FOUND
       AND existing_decision.decision = p_decision
       AND existing_decision.params_hash = p_params_hash
       AND existing_decision.actor_subject_id = p_actor_subject_id THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'approval_not_pending' USING ERRCODE = 'P0001';
  END IF;
  IF approval_row.revision <> p_expected_revision
     OR approval_row.params_hash <> p_params_hash
     OR approval_row.expires_at <= now() THEN
    RAISE EXCEPTION 'approval_stale_or_expired' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.approval
  SET status = p_decision,
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_approval_id AND org_id = p_org_id;
  INSERT INTO work.approval_decision
    (approval_id, org_id, decision, actor_subject_id, params_hash, policy_epoch)
  VALUES
    (p_approval_id, p_org_id, p_decision, p_actor_subject_id, p_params_hash, approval_row.policy_epoch);
  IF p_decision = 'approved' THEN
    UPDATE work.operation
    SET state = 'authorized',
        revision = revision + 1,
        updated_at = now()
    WHERE id = operation_row.id AND org_id = p_org_id;
  ELSE
    UPDATE work.operation
    SET state = 'canceled',
        revision = revision + 1,
        updated_at = now()
    WHERE id = operation_row.id AND org_id = p_org_id;
    SELECT id INTO reservation_id
    FROM work.budget_reservation
    WHERE operation_id = operation_row.id AND state = 'held';
    IF reservation_id IS NOT NULL THEN
      PERFORM work.release_budget(reservation_id);
    END IF;
  END IF;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'approval.decided',
    jsonb_build_object(
      'approval_id', p_approval_id,
      'operation_id', operation_row.id,
      'decision', p_decision
    )
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'approval.decide', 'approval', p_approval_id::text,
    jsonb_build_object('operation_id', operation_row.id, 'decision', p_decision)
  );
END;
$$;

-- 单聚合按 outbox_seq 严格有序：同一 (aggregate_type, aggregate_id) 只有最早的
-- 未投递、未死信行可被领取；被其他 relay 锁住或退避中的头部行会挡住后续行。
-- 跨聚合不保证顺序。死信行不再阻塞（下游以 DB 状态幂等兜底，并告警）。
CREATE FUNCTION work.claim_outbox(p_limit int DEFAULT 50)
RETURNS SETOF work.outbox
LANGUAGE sql AS $$
  SELECT o.*
  FROM work.outbox o
  WHERE o.delivered_at IS NULL
    AND o.dead_lettered_at IS NULL
    AND o.available_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM work.outbox e
      WHERE e.aggregate_type = o.aggregate_type
        AND e.aggregate_id = o.aggregate_id
        AND e.outbox_seq < o.outbox_seq
        AND e.delivered_at IS NULL
        AND e.dead_lettered_at IS NULL
    )
  ORDER BY o.outbox_seq
  LIMIT GREATEST(p_limit, 1)
  FOR UPDATE OF o SKIP LOCKED;
$$;

-- 投递失败：可重试按 2^attempts 秒退避（上限 300s），第 8 次或不可重试即死信。
CREATE FUNCTION work.mark_outbox_failed(
  p_event_id uuid,
  p_error_code text,
  p_retryable boolean
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
  next_attempts int;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO row_
  FROM work.outbox
  WHERE event_id = p_event_id
    AND org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox_event_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF row_.delivered_at IS NOT NULL THEN
    RETURN 'delivered';
  END IF;
  IF row_.dead_lettered_at IS NOT NULL THEN
    RETURN 'dead_letter';
  END IF;
  next_attempts := row_.attempts + 1;
  IF NOT p_retryable OR next_attempts >= 8 THEN
    UPDATE work.outbox
    SET attempts = next_attempts, last_error_code = p_error_code, dead_lettered_at = now()
    WHERE id = row_.id;
    PERFORM work.append_audit(
      row_.org_id, 'system:outbox-relay', 'outbox.dead_lettered', row_.aggregate_type,
      row_.aggregate_id::text,
      jsonb_build_object('event_id', p_event_id, 'attempts', next_attempts, 'error_code', p_error_code)
    );
    RETURN 'dead_letter';
  END IF;
  UPDATE work.outbox
  SET attempts = next_attempts,
      last_error_code = p_error_code,
      available_at = now() + make_interval(secs => LEAST(power(2, next_attempts), 300))
  WHERE id = row_.id;
  RETURN 'retry_scheduled';
END;
$$;

-- 运维重放死信：必须给理由；写审计；不改变 payload。
CREATE FUNCTION work.requeue_outbox_dead_letter(
  p_event_id uuid,
  p_actor_subject_id text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO row_
  FROM work.outbox
  WHERE event_id = p_event_id
    AND org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND OR row_.dead_lettered_at IS NULL THEN
    RAISE EXCEPTION 'outbox_event_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE work.outbox
  SET dead_lettered_at = NULL, attempts = 0, available_at = now()
  WHERE id = row_.id;
  PERFORM work.append_audit(
    row_.org_id, p_actor_subject_id, 'outbox.requeued', row_.aggregate_type,
    row_.aggregate_id::text,
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason, 'last_error_code', row_.last_error_code)
  );
END;
$$;

CREATE FUNCTION work.mark_outbox_delivered(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE work.outbox
  SET delivered_at = now(),
      attempts = attempts + 1
  WHERE event_id = p_event_id
    AND org_id = current_setting('app.org_id', true)
    AND delivered_at IS NULL;
  IF NOT FOUND THEN
    PERFORM 1 FROM work.outbox
    WHERE event_id = p_event_id
      AND org_id = current_setting('app.org_id', true);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'outbox_event_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 组织执行闸门：新增 Run/Operation/预算预留必须检查组织执行开通。
-- 终态/取消/对账更新不被此触发器阻断。
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.enforce_org_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM work.org
    WHERE id = NEW.org_id
      AND status = 'active'
      AND execution_enabled
      AND NOT operator_suspended
  ) THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_org_execution_insert
  BEFORE INSERT ON work.run
  FOR EACH ROW EXECUTE FUNCTION work.enforce_org_execution();
CREATE TRIGGER run_org_execution_active
  BEFORE UPDATE OF state ON work.run
  FOR EACH ROW
  WHEN (OLD.state <> 'active' AND NEW.state = 'active')
  EXECUTE FUNCTION work.enforce_org_execution();

CREATE TRIGGER operation_org_execution_insert
  BEFORE INSERT ON work.operation
  FOR EACH ROW EXECUTE FUNCTION work.enforce_org_execution();
CREATE TRIGGER operation_org_execution_start
  BEFORE UPDATE OF state ON work.operation
  FOR EACH ROW
  WHEN (OLD.state <> NEW.state AND NEW.state IN ('authorized', 'dispatching'))
  EXECUTE FUNCTION work.enforce_org_execution();

CREATE TRIGGER reservation_org_execution
  BEFORE INSERT ON work.budget_reservation
  FOR EACH ROW EXECUTE FUNCTION work.enforce_org_execution();

-- ---------------------------------------------------------------------------
-- R0a 任务摘要投影（供“我的工作”与 TaskDetail 使用）
-- ---------------------------------------------------------------------------
CREATE VIEW work.task_summary
WITH (security_invoker = true) AS
SELECT
  t.org_id,
  t.id AS task_id,
  t.owner_subject_id,
  t.title,
  t.state AS task_state,
  t.permission_mode,
  t.active_run_id,
  t.latest_run_id,
  t.revision,
  t.created_at,
  t.updated_at,
  r.state AS run_state,
  r.wait_reason,
  r.terminal_reason,
  a.id AS latest_artifact_id,
  av.version_no AS latest_artifact_version,
  av.content_hash AS latest_artifact_hash,
  (t.state = 'awaiting_acceptance') AS pending_acceptance,
  COALESCE((
    SELECT count(*)
    FROM work.operation o
    WHERE o.run_id = r.id
      AND o.org_id = t.org_id
      AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown', 'unresolved')
  ), 0) AS blocking_operations,
  COALESCE((
    SELECT SUM(br.amount_cents)
    FROM work.budget_reservation br
    JOIN work.operation o ON o.id = br.operation_id AND o.org_id = br.org_id
    WHERE o.run_id IN (
      SELECT rr.id FROM work.run rr WHERE rr.task_id = t.id AND rr.org_id = t.org_id
    )
      AND br.state IN ('held', 'unknown')
  ), 0) AS reserved_cents,
  COALESCE((
    SELECT SUM(be.amount_cents)
    FROM work.budget_entry be
    JOIN work.operation o ON o.id = be.operation_id AND o.org_id = be.org_id
    WHERE o.run_id IN (
      SELECT rr.id FROM work.run rr WHERE rr.task_id = t.id AND rr.org_id = t.org_id
    )
      AND be.kind IN ('settle', 'adjust')
  ), 0) AS settled_cents,
  CASE
    WHEN t.state = 'completed' THEN 'completed'
    WHEN t.state = 'canceled' THEN 'canceled'
    WHEN t.state = 'archived' THEN 'archived'
    WHEN t.state = 'awaiting_acceptance' THEN 'awaiting_acceptance'
    WHEN r.state = 'queued' THEN 'queued'
    WHEN r.state = 'cancel_requested' THEN 'canceling'
    WHEN r.state IN ('active', 'waiting') AND r.wait_reason = 'budget' THEN 'budget_exhausted'
    WHEN r.state IN ('active', 'waiting') AND EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.run_id = r.id AND o.org_id = t.org_id AND o.state IN ('unknown', 'unresolved')
    ) THEN 'reconciling'
    WHEN r.state IN ('active', 'waiting') THEN 'running'
    WHEN r.state = 'canceled' THEN 'run_canceled'
    WHEN r.state = 'failed' THEN 'failed'
    ELSE 'open'
  END AS display_state
FROM work.task t
LEFT JOIN work.run r
  ON r.id = t.latest_run_id AND r.org_id = t.org_id
LEFT JOIN LATERAL (
  SELECT ar.id
  FROM work.artifact ar
  WHERE ar.task_id = t.id
    AND ar.org_id = t.org_id
    AND ar.state = 'published'
  ORDER BY ar.updated_at DESC
  LIMIT 1
) a ON true
LEFT JOIN LATERAL (
  SELECT v.version_no, v.content_hash
  FROM work.artifact_version v
  WHERE v.artifact_id = a.id
    AND v.org_id = t.org_id
    AND v.state = 'published'
  ORDER BY v.version_no DESC
  LIMIT 1
) av ON true;

-- 标题编辑：仅 owner；乐观并发 + 幂等；事件/审计只记字段名，不记标题正文。
CREATE FUNCTION work.update_task_title(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_title text
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  clean_title text := btrim(p_title);
  req_hash text;
  dedup_row work.submission_dedup%ROWTYPE;
BEGIN
  IF p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF clean_title IS NULL OR char_length(clean_title) NOT BETWEEN 1 AND 80
     OR clean_title ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'title_invalid' USING ERRCODE = '22023';
  END IF;
  req_hash := encode(sha256(convert_to(p_task_id::text || ':' || clean_title, 'UTF8')), 'hex');

  SELECT * INTO task_row
  FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO dedup_row
  FROM work.submission_dedup
  WHERE org_id = p_org_id AND subject_id = p_subject_id
    AND operation_type = 'task_title' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN task_row.revision;
  END IF;

  IF task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = '40001',
      DETAIL = task_row.revision::text;
  END IF;
  IF task_row.state = 'archived' THEN
    RAISE EXCEPTION 'task_archived' USING ERRCODE = '55000';
  END IF;

  UPDATE work.task
  SET title = clean_title, revision = revision + 1, updated_at = now()
  WHERE id = p_task_id AND org_id = p_org_id;
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state)
  VALUES
    (p_org_id, p_subject_id, 'task_title', p_client_request_id, req_hash, p_task_id, 'updated');
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'task.updated', jsonb_build_object('fields', jsonb_build_array('title'))
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'task.title_update', 'task', p_task_id::text,
    jsonb_build_object('fields', jsonb_build_array('title'))
  );
  RETURN task_row.revision + 1;
END;
$$;

-- 成果下载审计：只记版本与哈希；读取正文本身由 Content Store 受控入口完成。
CREATE FUNCTION work.record_artifact_export(
  p_org_id text,
  p_artifact_id uuid,
  p_version_no int,
  p_subject_id text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  version_row work.artifact_version%ROWTYPE;
  owner_id text;
BEGIN
  SELECT t.owner_subject_id INTO owner_id
  FROM work.artifact a
  JOIN work.task t ON t.id = a.task_id AND t.org_id = a.org_id
  WHERE a.id = p_artifact_id AND a.org_id = p_org_id
    AND a.deleted_at IS NULL AND t.deleted_at IS NULL;
  IF owner_id IS NULL OR owner_id <> p_subject_id THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO version_row
  FROM work.artifact_version
  WHERE artifact_id = p_artifact_id AND org_id = p_org_id AND version_no = p_version_no;
  IF NOT FOUND OR version_row.state <> 'published' THEN
    RAISE EXCEPTION 'version_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN work.append_audit(
    p_org_id, p_subject_id, 'artifact.exported', 'artifact', p_artifact_id::text,
    jsonb_build_object('version_no', p_version_no, 'content_hash', version_row.content_hash,
                       'bytes', version_row.bytes, 'media_type', version_row.media_type)
  );
END;
$$;

-- 任务删除核心：要求静止（无 active Run、无阻塞 Operation）；逻辑 tombstone +
-- 正文引用进入 content_shred outbox（只含 content_ref，不含正文）。
-- 预算账本、审计与无正文事件保留；标题按敏感元数据清除。不授予任何应用角色。
CREATE FUNCTION work.delete_task_core(
  p_org_id text,
  p_task_id uuid,
  p_actor_subject_id text,
  p_reason text,
  p_action text
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  refs jsonb;
  artifact_count int;
BEGIN
  SELECT * INTO task_row
  FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.deleted_at IS NOT NULL THEN
    RETURN 0;
  END IF;
  IF task_row.active_run_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM work.operation o
    JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
    WHERE r.task_id = p_task_id AND r.org_id = p_org_id
      AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT ref), '[]'::jsonb) INTO refs
  FROM (
    SELECT v.content_ref AS ref
    FROM work.artifact a
    JOIN work.artifact_version v ON v.artifact_id = a.id AND v.org_id = a.org_id
    WHERE a.task_id = p_task_id AND a.org_id = p_org_id
    UNION
    SELECT i.content_ref
    FROM work.input_object i
    WHERE i.id = task_row.input_id AND i.org_id = p_org_id
  ) s;

  INSERT INTO work.artifact_tombstone (artifact_id, org_id)
  SELECT a.id, a.org_id FROM work.artifact a
  WHERE a.task_id = p_task_id AND a.org_id = p_org_id AND a.deleted_at IS NULL
  ON CONFLICT (artifact_id) DO NOTHING;
  UPDATE work.artifact
  SET state = 'deleted', deleted_at = now(), updated_at = now()
  WHERE task_id = p_task_id AND org_id = p_org_id AND deleted_at IS NULL;
  GET DIAGNOSTICS artifact_count = ROW_COUNT;

  UPDATE work.input_object
  SET status = 'deleted', deleted_at = now()
  WHERE id = task_row.input_id AND org_id = p_org_id AND deleted_at IS NULL;

  UPDATE work.submission_dedup
  SET task_deleted = true
  WHERE org_id = p_org_id AND task_id = p_task_id;

  UPDATE work.task
  SET deleted_at = now(), title = '[deleted]', revision = revision + 1, updated_at = now()
  WHERE id = p_task_id AND org_id = p_org_id;

  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (p_org_id, 'content', p_task_id, gen_random_uuid(),
          jsonb_build_object('kind', 'content_shred', 'task_id', p_task_id, 'content_refs', refs));

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, p_action, 'task', p_task_id::text,
    jsonb_build_object('reason', p_reason, 'artifacts', artifact_count,
                       'content_refs', jsonb_array_length(refs), 'owner_subject_id', task_row.owner_subject_id)
  );
  RETURN jsonb_array_length(refs);
END;
$$;

-- 用户删除自己的任务。
CREATE FUNCTION work.delete_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_reason text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM work.task
    WHERE id = p_task_id AND org_id = p_org_id AND owner_subject_id = p_subject_id
  ) THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN work.delete_task_core(p_org_id, p_task_id, p_subject_id, p_reason, 'task.deleted');
END;
$$;

-- 运维代执行删除（法务/组织退出/离职清理）：必须带工单号。
CREATE FUNCTION work.ops_delete_task(
  p_org_id text,
  p_task_id uuid,
  p_actor_subject_id text,
  p_ticket_ref text,
  p_reason text
) RETURNS int
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ticket_ref IS NULL OR p_ticket_ref !~ '^[A-Z][A-Z0-9]+-[0-9]+$' OR length(btrim(coalesce(p_reason, ''))) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  RETURN work.delete_task_core(
    p_org_id, p_task_id, p_actor_subject_id, p_ticket_ref || ': ' || p_reason, 'task.deleted_by_ops'
  );
END;
$$;

-- 所有权转移（试点人工流程）：新 owner 必须是同组织在职、有 Work 席位成员；
-- 任务须静止；不复制原 owner 的任何授权；原 owner 立即失去访问。
CREATE FUNCTION work.transfer_task_ownership(
  p_org_id text,
  p_task_id uuid,
  p_new_owner text,
  p_actor_subject_id text,
  p_ticket_ref text,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
BEGIN
  IF p_ticket_ref IS NULL OR p_ticket_ref !~ '^[A-Z][A-Z0-9]+-[0-9]+$' OR length(btrim(coalesce(p_reason, ''))) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO task_row
  FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.owner_subject_id = p_new_owner THEN
    RETURN task_row.revision;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.member
    WHERE org_id = p_org_id AND subject_id = p_new_owner AND status = 'active' AND work_seat
  ) THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = '42501';
  END IF;
  IF task_row.active_run_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM work.operation o
    JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
    WHERE r.task_id = p_task_id AND r.org_id = p_org_id
      AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = '55000';
  END IF;
  UPDATE work.task
  SET owner_subject_id = p_new_owner, revision = revision + 1, updated_at = now()
  WHERE id = p_task_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'task.owner_changed', jsonb_build_object('fields', jsonb_build_array('owner'))
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'task.ownership_transferred', 'task', p_task_id::text,
    jsonb_build_object('from', task_row.owner_subject_id, 'to', p_new_owner,
                       'ticket_ref', p_ticket_ref, 'reason', p_reason)
  );
  RETURN task_row.revision + 1;
END;
$$;

-- 生命周期事件由触发器统一补发，覆盖 finish_run/accept_task/cancel/对账等全部写路径，
-- 供 SSE 时间线与试点指标使用；payload 不含正文、标题或完成理由文本。
CREATE FUNCTION work.emit_run_terminal_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('succeeded', 'failed', 'canceled') AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM work.append_task_event(
      NEW.org_id, NEW.task_id, 'run.' || NEW.state,
      jsonb_build_object('run_id', NEW.id, 'attempt_no', NEW.attempt_no, 'terminal_reason', NEW.terminal_reason)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_terminal_event
AFTER UPDATE OF state ON work.run
FOR EACH ROW EXECUTE FUNCTION work.emit_run_terminal_event();

CREATE FUNCTION work.emit_task_state_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'awaiting_acceptance' AND OLD.state IS DISTINCT FROM 'awaiting_acceptance' THEN
    PERFORM work.append_task_event(
      NEW.org_id, NEW.id, 'task.awaiting_acceptance',
      jsonb_build_object('latest_run_id', NEW.latest_run_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_state_event
AFTER UPDATE OF state ON work.task
FOR EACH ROW EXECUTE FUNCTION work.emit_task_state_event();

CREATE FUNCTION work.emit_acceptance_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.append_task_event(
    NEW.org_id, NEW.task_id, 'task.completed',
    jsonb_build_object(
      'acceptance_id', NEW.id,
      'basis', CASE WHEN NEW.artifact_id IS NULL THEN 'reason' ELSE 'version' END,
      'artifact_id', NEW.artifact_id,
      'version_no', NEW.version_no
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptance_event
AFTER INSERT ON work.acceptance
FOR EACH ROW EXECUTE FUNCTION work.emit_acceptance_event();
