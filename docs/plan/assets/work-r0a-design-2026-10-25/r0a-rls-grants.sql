-- R0a RLS、函数所有权与最小权限
-- 应用每事务 SET LOCAL app.org_id；FORCE 让表 owner 也受策略约束。

ALTER TABLE work.org ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.org FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON work.org
  USING (id = current_setting('app.org_id', true))
  WITH CHECK (id = current_setting('app.org_id', true));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'member', 'org_policy', 'capability_snapshot', 'input_object',
    'task', 'run', 'operation', 'approval', 'approval_operation',
    'submission_dedup', 'quota_account', 'quota_reservation',
    'provider_credential', 'provider_access_config', 'usage_daily',
    'artifact', 'artifact_version', 'upload_session', 'acceptance',
    'outbox', 'audit_export'
  ]::text[]
  LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE work.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON work.%I USING (org_id = current_setting(''app.org_id'', true)) WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
  END LOOP;
END;
$$;

-- Relay 跨组织：仅 work_owner 身份（领域函数内）且函数临时打开 app.outbox_relay 时可见全部组织的 outbox。
CREATE POLICY outbox_relay ON work.outbox
  USING (current_user = 'work_owner' AND current_setting('app.outbox_relay', true) = 'on')
  WITH CHECK (current_user = 'work_owner' AND current_setting('app.outbox_relay', true) = 'on');

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'approval_decision', 'quota_entry', 'task_event', 'audit_event', 'artifact_tombstone'
  ]::text[]
  LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE work.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_select ON work.%I FOR SELECT USING (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_insert ON work.%I FOR INSERT WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
  END LOOP;
END;
$$;

-- 所有函数由 work_owner 拥有，作为领域命令执行；只给应用 EXECUTE，不给直接 DML。
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'work'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', fn.signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path = work, pg_catalog', fn.signature);
  END LOOP;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA work FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA work FROM PUBLIC;

GRANT USAGE ON SCHEMA work TO work_api, work_worker, work_ledger, work_ops, work_directory;
GRANT SELECT ON ALL TABLES IN SCHEMA work TO work_api, work_worker;
-- API 不读 outbox/幂等表（避免跨用户请求元数据可见）；relay 走 claim_outbox。
-- 审计导出作业元数据（内容引用、行数、下载状态）只对管理员函数可见，走领域函数。
REVOKE SELECT ON work.outbox, work.submission_dedup, work.audit_export FROM work_api;
REVOKE SELECT ON work.audit_export FROM work_worker;
-- 接入配置与凭证只经领域函数出入：API 与 worker 都没有直接读表路径，
-- 凭证密文列对应用身份不可见（resolve_provider_context 是唯一取用入口）。
REVOKE SELECT ON work.provider_credential, work.provider_access_config FROM work_api;
REVOKE SELECT ON work.provider_credential, work.provider_access_config FROM work_worker;
REVOKE SELECT ON work.usage_daily FROM work_api, work_worker;
GRANT SELECT ON work.task_summary TO work_api, work_worker;

-- 账本/审计角色只读：所有账本写入必须经领域函数（reserve/settle/adjust/release），不允许直接 INSERT。
GRANT SELECT ON work.quota_entry, work.quota_reservation, work.quota_account, work.audit_event TO work_ledger;

GRANT EXECUTE ON FUNCTION work.create_input(text, text, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.submit_task(text, text, text, uuid, text, text, text, jsonb, text[], jsonb, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.retry_task(text, uuid, text, text, bigint, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.request_cancel(text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.update_task_title(text, uuid, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.record_artifact_export(text, uuid, int, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.create_user_artifact_version(text, uuid, text, text, int, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.publish_artifact(text, uuid, uuid, text, text, text, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.accept_task(text, uuid, text, text, bigint, uuid, int, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.request_approval(text, uuid, text, jsonb, text, timestamptz, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.decide_approval(text, uuid, text, text, bigint, text) TO work_api;

GRANT EXECUTE ON FUNCTION work.acquire_run(uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.create_operation(uuid, text, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.authorize_operation(text, uuid, bigint, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_operation(text, uuid, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.cancel_operation(text, uuid, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.reserve_quota(text, text, text, uuid, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_dispatch(uuid, text, text, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.settle_quota(uuid, bigint, jsonb, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.adjust_quota(uuid, bigint, text, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.release_quota(uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_run(uuid, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_outbox(text, int, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_outbox_delivered(uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_outbox_failed(uuid, text, text, boolean) TO work_worker;
GRANT EXECUTE ON FUNCTION work.requeue_outbox_dead_letter(uuid, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.skip_outbox_dead_letter(uuid, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.delete_task(text, uuid, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.ops_delete_task(text, uuid, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.transfer_task_ownership(text, uuid, text, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.wait_run(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.resume_run(text, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_operation_unknown(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.reconcile_operation(text, uuid, text, text, bigint, text) TO work_worker;

-- Host 目录投影（ADR-0021）：只有 work_directory 服务身份能写 org/member 投影，
-- 且必须经 sync_* 领域命令；应用与 worker 角色没有直接 DML，也不能调用这两个函数。
GRANT EXECUTE ON FUNCTION work.sync_org_projection(text, text, text, boolean, text, bigint) TO work_directory;
GRANT EXECUTE ON FUNCTION work.sync_member_projection(text, text, text, text, boolean, bigint) TO work_directory;

-- 管理只读（U2 方案 B）：role/revision/席位/token 配额与审计导出作业由 R0a 领域函数给出。
GRANT EXECUTE ON FUNCTION work.admin_overview(text, text, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.list_seats(text, text, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.create_audit_export(text, text, text, timestamptz, timestamptz, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_audit_export(text, text, uuid) TO work_api;
GRANT EXECUTE ON FUNCTION work.issue_audit_export_download(text, text, uuid, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.redeem_audit_export_download(text, text, text) TO work_api;
-- 导出 worker：只领取与收尾作业，正文进 Content Store，库内只留引用与哈希。
GRANT EXECUTE ON FUNCTION work.claim_audit_export(uuid, text, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.complete_audit_export(uuid, text, text, text, bigint, bigint, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.fail_audit_export(uuid, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.expire_due_audit_exports(timestamptz) TO work_worker;
GRANT EXECUTE ON FUNCTION work.expire_due_inputs(timestamptz) TO work_worker;
GRANT EXECUTE ON FUNCTION work.shred_due_audit_exports(timestamptz) TO work_worker;

-- D-08 大模型接入与用量：配置写只给 owner（函数内断言）；网关取凭证只给 worker。
GRANT EXECUTE ON FUNCTION work.create_provider_credential(text, text, text, text, text, bytea, bytea, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.rotate_provider_credential(text, text, uuid, bytea, bytea, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_provider_credential(text, text, uuid, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.set_provider_config(text, text, text, text, text, text, text, uuid, bigint) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_provider_config(text, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_user_usage(text, text, date, date) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_org_usage_by_model(text, text, date, date) TO work_api;
GRANT EXECUTE ON FUNCTION work.resolve_provider_context(text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.record_usage(text, text, text, text, date, bigint, bigint, bigint, int) TO work_worker;
