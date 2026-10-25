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
    'submission_dedup', 'budget_account', 'budget_reservation',
    'artifact', 'artifact_version', 'upload_session', 'acceptance',
    'outbox'
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

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'approval_decision', 'budget_entry', 'task_event', 'audit_event', 'artifact_tombstone'
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

GRANT USAGE ON SCHEMA work TO work_api, work_worker, work_ledger, work_ops;
GRANT SELECT ON ALL TABLES IN SCHEMA work TO work_api, work_worker;
GRANT SELECT ON work.task_summary TO work_api, work_worker;

-- 账本/审计追加角色只获得追加表 INSERT + SELECT，不获得业务事实表写权限。
GRANT SELECT, INSERT ON work.budget_entry, work.task_event, work.audit_event TO work_ledger;

GRANT EXECUTE ON FUNCTION work.create_input(text, text, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.submit_task(text, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, text, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.create_run(uuid, text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.request_cancel(text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.update_task_title(text, uuid, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.record_artifact_export(text, uuid, int, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.publish_artifact(text, uuid, uuid, text, text, text, bigint, text, jsonb) TO work_api, work_worker;
GRANT EXECUTE ON FUNCTION work.accept_task(uuid, text, uuid, int, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.request_approval(text, uuid, text, jsonb, text, timestamptz, bigint) TO work_api;
GRANT EXECUTE ON FUNCTION work.decide_approval(text, uuid, text, text, bigint, text) TO work_api;

GRANT EXECUTE ON FUNCTION work.acquire_run(uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.create_operation(uuid, text, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.authorize_operation(text, uuid, bigint, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_operation(text, uuid, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.cancel_operation(text, uuid, text, text) TO work_api, work_worker;
GRANT EXECUTE ON FUNCTION work.reserve_budget(text, text, text, uuid, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_dispatch(uuid, text, text, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.settle_budget(uuid, bigint, text, jsonb, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.adjust_budget(uuid, bigint, text, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.release_budget(uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_run(uuid, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_outbox(int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_outbox_delivered(uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_outbox_failed(uuid, text, boolean) TO work_worker;
GRANT EXECUTE ON FUNCTION work.requeue_outbox_dead_letter(uuid, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.delete_task(text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.ops_delete_task(text, uuid, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.transfer_task_ownership(text, uuid, text, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.wait_run(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.resume_run(text, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_operation_unknown(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.reconcile_operation(text, uuid, text, text, bigint, text, text) TO work_worker;
