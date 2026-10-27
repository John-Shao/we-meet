-- R0a 加固：覆盖基线 DDL 中的部分领域命令，并新增 API 侧重试/采纳/用户版本命令。
-- 原则：API 命令都校验会话主体 = owner、任务未删除、乐观并发与幂等；Worker 命令对活动重试幂等。

-- 基线 create_run 不校验 owner/删除，也不写 start_workflow；R0a 由 retry_task 取代。
DROP FUNCTION work.create_run(uuid, text, uuid, text, text);
DROP FUNCTION work.accept_task(uuid, text, uuid, int, text, bigint, text);

-- Run 终态：活动重试幂等（已是目标终态直接返回）；原因只收枚举码。
CREATE OR REPLACE FUNCTION work.finish_run(
  p_run_id uuid,
  p_org_id text,
  p_outcome text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_task_id uuid;
  reason text := work.reason_code(p_reason);
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'invalid_run_outcome' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO v_task_id FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t
  WHERE t.id = v_task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id FOR UPDATE;
  IF run_row.state = p_outcome THEN
    RETURN;
  END IF;
  -- 取消请求已落库后不得再以成功收尾（迟到结果只结算、不发布）。
  IF p_outcome = 'succeeded' AND run_row.state = 'cancel_requested' THEN
    RAISE EXCEPTION 'run_cancel_requested' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome = 'succeeded' AND work.task_has_blocking_operation(v_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_has_unresolved_operation' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run r
  SET state = p_outcome,
      wait_reason = NULL,
      terminal_reason = reason,
      control_revision = r.control_revision + 1,
      updated_at = now()
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  UPDATE work.task t
  SET state = CASE WHEN p_outcome = 'succeeded' THEN 'awaiting_acceptance' ELSE t.state END,
      active_run_id = NULL,
      latest_run_id = p_run_id,
      revision = t.revision + 1,
      updated_at = now()
  WHERE t.id = v_task_id AND t.org_id = p_org_id;
END;
$$;

-- 领取 Run：queued → active 时 fence+1；活动重试（结果丢失）时 Run 已 active/waiting 则返回当前行，不再报 run_not_queued；
-- 启动前已 cancel_requested 或已终态则返回当前行，工作流据此直接收尾。
CREATE OR REPLACE FUNCTION work.acquire_run(
  p_run_id uuid,
  p_org_id text
) RETURNS work.run
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_task_id uuid;
BEGIN
  SELECT r.task_id INTO v_task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t WHERE t.id = v_task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run r WHERE r.id = p_run_id AND r.org_id = p_org_id FOR UPDATE;
  -- 启动前已取消或已终态：原样返回，由工作流收尾，不 bump fence。
  IF run_row.state IN ('cancel_requested', 'succeeded', 'failed', 'canceled') THEN
    RETURN run_row;
  END IF;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state IN ('active', 'waiting') THEN
    RETURN run_row;
  END IF;
  IF run_row.state <> 'queued' THEN
    RAISE EXCEPTION 'run_not_queued' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run r
  SET state = 'active',
      fence = r.fence + 1,
      control_revision = r.control_revision + 1,
      updated_at = now()
  WHERE r.id = p_run_id AND r.org_id = p_org_id
  RETURNING * INTO run_row;
  RETURN run_row;
END;
$$;

-- 派发许可：同 consumer + 同 fence 的重放返回已有 dispatch_attempt_id；其余未赢得返回 NULL，
-- 调用方需重读 Operation 状态：authorized 且 Run 取消中 → cancel_operation + finish_run(canceled)；
-- 已由其他 consumer/fence 派发 → 不动（结果归属派发方，崩溃由对账扫描接管）。
CREATE OR REPLACE FUNCTION work.claim_dispatch(
  p_operation_id uuid,
  p_org_id text,
  p_consumer_id text,
  p_fence bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  attempt uuid := gen_random_uuid();
BEGIN
  SELECT * INTO operation_row FROM work.operation o WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO run_row FROM work.run r WHERE r.id = operation_row.run_id AND r.org_id = p_org_id;
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run r WHERE r.id = operation_row.run_id AND r.org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row FROM work.operation o WHERE o.id = p_operation_id AND o.org_id = p_org_id FOR UPDATE;
  IF operation_row.state = 'dispatching'
     AND operation_row.consumer_id = p_consumer_id
     AND run_row.fence = p_fence THEN
    RETURN operation_row.dispatch_attempt_id;
  END IF;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active'
     OR run_row.fence <> p_fence
     OR operation_row.state <> 'authorized'
     OR operation_row.dispatch_attempt_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  UPDATE work.operation o
  SET state = 'dispatching',
      dispatch_attempt_id = attempt,
      consumer_id = p_consumer_id,
      revision = o.revision + 1,
      updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  RETURN attempt;
END;
$$;

-- 预留：同 Operation 已有同额 held/unknown 预留时返回该预留（活动重试幂等）。
CREATE OR REPLACE FUNCTION work.reserve_quota(
  p_org_id text,
  p_account_key text,
  p_period_id text,
  p_operation_id uuid,
  p_amount_tokens bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  account work.quota_account%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  existing work.quota_reservation%ROWTYPE;
  reservation_id uuid := gen_random_uuid();
  next_seq int;
  run_cumulative_tokens bigint;
BEGIN
  IF p_amount_tokens IS NULL OR p_amount_tokens <= 0 THEN
    RAISE EXCEPTION 'invalid_reservation_amount' USING ERRCODE = '22023';
  END IF;
  -- Run 级硬上限对所有组织生效（D-08）。
  SELECT * INTO policy_row FROM work.org_policy WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Run 级累计检查：已结算 + 已预留（held/unknown）不得超过 run_cap_tokens（D-08）。
  SELECT COALESCE(SUM(br.settled_tokens), 0) + COALESCE(SUM(
    CASE WHEN br.state IN ('held', 'unknown') THEN br.amount_tokens ELSE 0 END
  ), 0) INTO run_cumulative_tokens
  FROM work.quota_reservation br
  JOIN work.operation o ON o.id = br.operation_id
  WHERE o.run_id = operation_row.run_id AND o.org_id = p_org_id;
  IF run_cumulative_tokens + p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO existing
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id AND br.state IN ('held', 'unknown');
  IF FOUND THEN
    IF existing.amount_tokens = p_amount_tokens THEN
      RETURN existing.id;
    END IF;
    RAISE EXCEPTION 'operation_has_active_reservation' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state NOT IN ('prepared', 'waiting_approval', 'authorized') THEN
    RAISE EXCEPTION 'operation_not_reservable' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(br.reservation_seq), 0) + 1 INTO next_seq
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id;
  SELECT * INTO account
  FROM work.quota_account ba
  WHERE ba.org_id = p_org_id AND ba.account_key = p_account_key AND ba.period_id = p_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- soft：客户自带账号，周期量只统计；hard：演示组织等平台承担成本的组织，超限即拒。
  IF account.enforcement = 'hard'
     AND account.limit_tokens - account.settled_tokens - account.reserved_tokens < p_amount_tokens THEN
    RAISE EXCEPTION 'quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.quota_account ba
  SET reserved_tokens = ba.reserved_tokens + p_amount_tokens,
      version = ba.version + 1,
      updated_at = now()
  WHERE ba.id = account.id;
  INSERT INTO work.quota_reservation
    (id, org_id, account_id, operation_id, reservation_seq, amount_tokens, state)
  VALUES
    (reservation_id, p_org_id, account.id, p_operation_id, next_seq, p_amount_tokens, 'held');
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens)
  VALUES
    (p_org_id, account.id, reservation_id, p_operation_id, 'reserve', p_amount_tokens);
  RETURN reservation_id;
END;
$$;

-- 用户重试：仅 owner、未删除、最新 Run 为 failed/canceled、任务静止；沿用任务快照；
-- 写 start_workflow outbox；幂等键返回同一 Run。
CREATE FUNCTION work.retry_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_workflow_id text,
  p_runtime_version text
) RETURNS TABLE (run_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
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
  IF p_workflow_id IS NULL OR p_workflow_id = '' OR p_runtime_version IS NULL OR p_runtime_version = '' THEN
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
    (new_run_id, p_org_id, p_task_id, next_attempt, 'queued', task_row.snapshot_id, p_workflow_id, p_runtime_version);
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
    jsonb_build_object('kind', 'start_workflow', 'run_id', new_run_id, 'workflow_id', p_workflow_id)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'run.retry', 'task', p_task_id::text,
    jsonb_build_object('run_id', new_run_id, 'attempt_no', next_attempt)
  );
  RETURN QUERY SELECT new_run_id, task_row.revision + 1;
END;
$$;

-- 用户采纳：仅 owner、未删除、状态 awaiting_acceptance、静止；固定版本或完成理由；
-- revision 冲突返回 version_conflict（DETAIL=当前 revision）；幂等键返回同一采纳。
CREATE FUNCTION work.accept_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_artifact_id uuid,
  p_version_no int,
  p_completion_reason text
) RETURNS TABLE (acceptance_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  req_hash text;
  new_acceptance_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'task.accept', p_client_request_id);
  IF (p_artifact_id IS NULL) = (p_completion_reason IS NULL)
     OR (p_artifact_id IS NOT NULL AND p_version_no IS NULL)
     OR (p_completion_reason IS NOT NULL AND char_length(btrim(p_completion_reason)) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'acceptance_requires_artifact_or_reason' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(concat_ws(':', p_task_id, p_expected_revision, p_artifact_id, p_version_no,
                                         work.sha256_text(COALESCE(p_completion_reason, ''))));
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'task.accept' AND d.client_request_id = p_client_request_id;
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
  IF task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = task_row.revision::text;
  END IF;
  IF task_row.state <> 'awaiting_acceptance' THEN
    RAISE EXCEPTION 'task_not_acceptable' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL OR work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;
  IF p_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM work.artifact a
    JOIN work.artifact_version v ON v.artifact_id = a.id AND v.org_id = a.org_id
    WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.task_id = p_task_id
      AND a.deleted_at IS NULL AND v.version_no = p_version_no
      AND a.state = 'published' AND v.state = 'published'
  ) THEN
    RAISE EXCEPTION 'artifact_not_published' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.task t
  SET state = 'completed', revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;
  INSERT INTO work.acceptance
    (id, org_id, task_id, artifact_id, version_no, actor_subject_id, task_revision, completion_reason)
  VALUES
    (new_acceptance_id, p_org_id, p_task_id, p_artifact_id, p_version_no, p_subject_id,
     p_expected_revision + 1, btrim(p_completion_reason));
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'task.accept', p_client_request_id, req_hash, p_task_id, 'completed',
     new_acceptance_id::text);
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'task.accept', 'task', p_task_id::text,
    jsonb_build_object('acceptance_id', new_acceptance_id,
                       'basis', CASE WHEN p_artifact_id IS NULL THEN 'reason' ELSE 'version' END,
                       'artifact_id', p_artifact_id, 'version_no', p_version_no)
  );
  RETURN QUERY SELECT new_acceptance_id, task_row.revision + 1;
END;
$$;

-- 用户编辑成果另存新版本：仅 owner、未删除、任务静止且未完成（open/awaiting_acceptance）；
-- base_version_no 必须等于当前最新已发布版本（否则 version_conflict，DETAIL=最新版本号）；
-- 版本不可变、来源标为 user；任务 revision +1，使旧视图的采纳失效。
CREATE FUNCTION work.create_user_artifact_version(
  p_org_id text,
  p_artifact_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_base_version_no int,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text
) RETURNS TABLE (version_no int, task_revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  artifact_row work.artifact%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  v_task_id uuid;
  latest_version int;
  req_hash text;
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'artifact.version', p_client_request_id);
  IF p_base_version_no IS NULL OR p_base_version_no < 1
     OR p_content_ref IS NULL OR p_content_ref = ''
     OR p_content_hash IS NULL OR p_content_hash = ''
     OR p_bytes IS NULL OR p_bytes <= 0
     OR p_media_type IS NULL OR p_media_type = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(concat_ws(':', p_artifact_id, p_base_version_no, p_content_hash));
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'artifact.version' AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted THEN
      RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY
      SELECT dedup_row.result_ref::int, t.revision
      FROM work.task t WHERE t.id = dedup_row.task_id AND t.org_id = p_org_id;
    RETURN;
  END IF;

  SELECT a.task_id INTO v_task_id FROM work.artifact a WHERE a.id = p_artifact_id AND a.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t
  WHERE t.id = v_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  SELECT * INTO artifact_row FROM work.artifact a
  WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.deleted_at IS NULL
  FOR UPDATE;
  IF task_row.id IS NULL OR artifact_row.id IS NULL OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.state NOT IN ('open', 'awaiting_acceptance') THEN
    RAISE EXCEPTION 'artifact_read_only' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;
  -- UI shows run_canceled/failed artifacts as read-only: a terminal, unsuccessful
  -- latest run freezes editing until a later run succeeds.
  IF task_row.latest_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM work.run r
    WHERE r.id = task_row.latest_run_id AND r.org_id = p_org_id
      AND r.state IN ('failed', 'canceled')
  ) THEN
    RAISE EXCEPTION 'artifact_read_only' USING ERRCODE = 'P0001';
  END IF;
  SELECT MAX(v.version_no) INTO latest_version
  FROM work.artifact_version v
  WHERE v.artifact_id = p_artifact_id AND v.org_id = p_org_id AND v.state = 'published';
  IF latest_version IS DISTINCT FROM p_base_version_no THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = COALESCE(latest_version, 0)::text;
  END IF;
  INSERT INTO work.artifact_version
    (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type, state, provenance)
  VALUES
    (p_artifact_id, p_org_id, latest_version + 1, p_content_ref, p_content_hash, p_bytes, p_media_type,
     'staged', jsonb_build_object('source', 'user', 'base_version_no', p_base_version_no));
  UPDATE work.artifact_version v
  SET state = 'published', published_at = now()
  WHERE v.artifact_id = p_artifact_id AND v.org_id = p_org_id AND v.version_no = latest_version + 1;
  UPDATE work.artifact a
  SET revision = a.revision + 1, updated_at = now()
  WHERE a.id = p_artifact_id AND a.org_id = p_org_id;
  UPDATE work.task t
  SET revision = t.revision + 1, updated_at = now()
  WHERE t.id = v_task_id AND t.org_id = p_org_id;
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'artifact.version', p_client_request_id, req_hash, v_task_id, 'published',
     (latest_version + 1)::text);
  PERFORM work.append_task_event(
    p_org_id, v_task_id, 'artifact.published',
    jsonb_build_object('artifact_id', p_artifact_id, 'version_no', latest_version + 1, 'source', 'user',
                       'content_hash', p_content_hash, 'bytes', p_bytes, 'media_type', p_media_type)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'artifact.version_create', 'artifact', p_artifact_id::text,
    jsonb_build_object('task_id', v_task_id, 'version_no', latest_version + 1, 'base_version_no', p_base_version_no)
  );
  RETURN QUERY SELECT latest_version + 1, task_row.revision + 1;
END;
$$;
