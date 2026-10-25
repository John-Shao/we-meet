-- R0a schema smoke test
-- Run after r0a-schema-draft.sql in a disposable PostgreSQL 16 database.
-- Covers: input/task submission, idempotency, scope rejection, direct-DML denial,
-- RLS, worker dispatch, budget settle/adjust, artifact publish, acceptance,
-- approval path, cancel/retry, outbox delivery, and task summary projection.
\set ON_ERROR_STOP on

BEGIN;

-- Seed as superuser (bypasses RLS).
INSERT INTO work.org (id, status, execution_enabled, home_region)
VALUES ('org1', 'active', true, 'cn-north'),
       ('org2', 'active', true, 'cn-north');

INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
VALUES ('org1', 'user1', 'active', 'owner', true),
       ('org2', 'user2', 'active', 'owner', true);

INSERT INTO work.org_policy
  (org_id, revision, force_ask_each, allow_auto_readonly, allow_plan_approval, policy)
VALUES
  ('org1', 1, false, true, false, '{"schema":"r0a-policy-v1"}'::jsonb),
  ('org2', 1, false, true, false, '{"schema":"r0a-policy-v1"}'::jsonb);

INSERT INTO work.budget_account
  (org_id, account_key, period_id, currency, limit_cents)
VALUES
  ('org1', 'default', '2026-10', 'CNY', 10000),
  ('org2', 'default', '2026-10', 'CNY', 10000);

SET LOCAL app.org_id = 'org1';
SET LOCAL ROLE work_api;

CREATE TEMP TABLE smoke_assert (
  name text PRIMARY KEY,
  ok boolean NOT NULL
);
GRANT SELECT, INSERT ON smoke_assert TO work_worker;

-- ---------------------------------------------------------------------------
-- Input + submit
-- ---------------------------------------------------------------------------
SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-1', 'sha256:input-1', 256, 'application/json'
) AS input_id \gset

SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-1', 'sha256:input-1', 256, 'application/json'
) AS input_id_2 \gset

CREATE TEMP TABLE ctx AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-0001', 'sha256:req-0001',
  :'input_id'::uuid, '测试方案', 'ask_each',
  'sha256:snap-001',
  '{"template":{"id":"tpl-report","version":1,"content_hash":"sha256:tpl-1"},"limits":{"goal":2000,"background":4000}}'::jsonb,
  ARRAY['model_call', 'read_builtin_template', 'write_artifact_draft']::text[],
  '{"provider":"qwen","model":"qwen3.8-flash"}'::jsonb,
  'price-v1', 'wf-req-0001', 'pi-1.4.0'
);

SELECT task_id, run_id FROM ctx \gset

INSERT INTO smoke_assert
SELECT 'input_idempotent', :'input_id'::uuid = :'input_id_2'::uuid;

INSERT INTO smoke_assert
SELECT 'submit_idempotent', count(*) = 1
FROM work.submit_task(
  'org1', 'user1', 'req-0001', 'sha256:req-0001',
  :'input_id'::uuid, '测试方案', 'ask_each',
  'sha256:snap-001',
  '{"template":{"id":"tpl-report","version":1,"content_hash":"sha256:tpl-1"},"limits":{"goal":2000,"background":4000}}'::jsonb,
  ARRAY['model_call', 'read_builtin_template', 'write_artifact_draft']::text[],
  '{"provider":"qwen","model":"qwen3.8-flash"}'::jsonb,
  'price-v1', 'wf-req-0001', 'pi-1.4.0'
);

INSERT INTO smoke_assert
SELECT 'one_task_after_retry', count(*) = 1 FROM work.task;

INSERT INTO smoke_assert
SELECT 'dedup_row', count(*) = 1 FROM work.submission_dedup;

INSERT INTO smoke_assert
SELECT 'workflow_start_outbox', count(*) = 1
FROM work.outbox
WHERE org_id = 'org1'
  AND aggregate_type = 'run'
  AND aggregate_id = :'run_id'::uuid
  AND payload->>'kind' = 'start_workflow';

-- Same key, different hash -> conflict.
DO $$ BEGIN
  BEGIN
    PERFORM 1
    FROM work.submit_task(
      'org1', 'user1', 'req-0001', 'sha256:different',
      (SELECT id FROM work.input_object WHERE org_id = 'org1' LIMIT 1),
      '测试方案', 'ask_each', 'sha256:snap-001',
      '{}'::jsonb,
      ARRAY['model_call']::text[],
      '{"provider":"qwen"}'::jsonb,
      'price-v1', 'wf-conflict', 'pi-1.4.0'
    );
    RAISE EXCEPTION 'expected_idempotency_conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%idempotency_key_conflict%' THEN RAISE; END IF;
  END;
END $$;

-- R0a rejects tools outside the frozen allowlist.
DO $$ BEGIN
  BEGIN
    PERFORM 1
    FROM work.submit_task(
      'org1', 'user1', 'req-0002', 'sha256:req-0002',
      (SELECT id FROM work.input_object WHERE org_id = 'org1' LIMIT 1),
      '越界工具', 'ask_each', 'sha256:snap-002',
      '{}'::jsonb,
      ARRAY['shell']::text[],
      '{"provider":"qwen"}'::jsonb,
      'price-v1', 'wf-scope', 'pi-1.4.0'
    );
    RAISE EXCEPTION 'expected_scope_unavailable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%scope_unavailable%' THEN RAISE; END IF;
  END;
END $$;

-- R0a does not expose plan approval.
DO $$ BEGIN
  BEGIN
    PERFORM 1
    FROM work.submit_task(
      'org1', 'user1', 'req-0003', 'sha256:req-0003',
      (SELECT id FROM work.input_object WHERE org_id = 'org1' LIMIT 1),
      '计划模式', 'plan_then_run', 'sha256:snap-003',
      '{}'::jsonb,
      ARRAY['model_call']::text[],
      '{"provider":"qwen"}'::jsonb,
      'price-v1', 'wf-plan', 'pi-1.4.0'
    );
    RAISE EXCEPTION 'expected_permission_mode_unavailable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%permission_mode_unavailable%' THEN RAISE; END IF;
  END;
END $$;

-- App roles have no direct DML on fact tables.
DO $$ BEGIN
  BEGIN
    INSERT INTO work.task
      (org_id, owner_subject_id, state, permission_mode, title, input_id)
    VALUES
      ('org1', 'user1', 'open', 'ask_each', 'direct-write',
       (SELECT id FROM work.input_object WHERE org_id = 'org1' LIMIT 1));
    RAISE EXCEPTION 'expected_permission_denied';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

-- Cross-org RLS: org2 sees zero org1 tasks.
SET LOCAL app.org_id = 'org2';
INSERT INTO smoke_assert
SELECT 'rls_org2_zero', count(*) = 0 FROM work.task;
SET LOCAL app.org_id = 'org1';

-- Least-privilege and FORCE RLS evidence.
SELECT NOT has_table_privilege('work_api', 'work.task', 'INSERT')
   AND NOT has_table_privilege('work_api', 'work.task', 'UPDATE')
   AND NOT has_table_privilege('work_api', 'work.task', 'DELETE') AS api_no_dml \gset
INSERT INTO smoke_assert SELECT 'api_no_direct_dml', :'api_no_dml'::boolean;

SELECT NOT has_table_privilege('work_worker', 'work.task', 'INSERT')
   AND NOT has_table_privilege('work_worker', 'work.task', 'UPDATE')
   AND NOT has_table_privilege('work_worker', 'work.task', 'DELETE') AS worker_no_dml \gset
INSERT INTO smoke_assert SELECT 'worker_no_direct_dml', :'worker_no_dml'::boolean;

SELECT has_table_privilege('work_ledger', 'work.budget_entry', 'INSERT')
   AND NOT has_table_privilege('work_ledger', 'work.task', 'INSERT') AS ledger_ok \gset
INSERT INTO smoke_assert SELECT 'ledger_append_only', :'ledger_ok'::boolean;

SELECT c.relrowsecurity AND c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'work' AND c.relname = 'task' \gset
INSERT INTO smoke_assert SELECT 'rls_force_task', :'rls_forced'::boolean;

SELECT bool_and(p.prosecdef) AS all_secdef, count(*) > 0 AS has_functions
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'work' \gset
INSERT INTO smoke_assert SELECT 'functions_security_definer', :'all_secdef'::boolean AND :'has_functions'::boolean;

-- ---------------------------------------------------------------------------
-- Worker path: acquire -> authorize -> reserve -> dispatch -> finish -> settle
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';

SELECT state AS run_state, fence
FROM work.acquire_run(:'run_id'::uuid, 'org1') \gset

INSERT INTO smoke_assert SELECT 'run_active', :'run_state' = 'active';

SELECT work.create_operation(
  :'run_id'::uuid, 'org1', 'model:step-1', 'model', 'sha256:model-1'
) AS op_id \gset

-- Connector operations are out of R0a scope.
DO $$ BEGIN
  BEGIN
    PERFORM work.create_operation(
      (SELECT id FROM work.run WHERE org_id = 'org1' ORDER BY created_at LIMIT 1),
      'org1', 'connector:1', 'connector', 'sha256:connector-1'
    );
    RAISE EXCEPTION 'expected_scope_unavailable_operation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%scope_unavailable%' THEN RAISE; END IF;
  END;
END $$;

SELECT work.authorize_operation('org1', :'op_id'::uuid, 1, 'policy_auto');

SELECT work.reserve_budget(
  'org1', 'default', '2026-10', :'op_id'::uuid, 100
) AS res_id \gset

SELECT work.claim_dispatch(
  :'op_id'::uuid, 'org1', 'worker-1', :'fence'::bigint
) AS dispatch_id \gset

INSERT INTO smoke_assert SELECT 'dispatch_once', :'dispatch_id'::uuid IS NOT NULL;

SELECT work.finish_operation(
  'org1', :'op_id'::uuid, 'succeeded', 'provider-req-1', 'receipt-1'
);

SELECT work.settle_budget(
  :'res_id'::uuid, 80, 'price-v1',
  '{"input_tokens":100,"output_tokens":200}'::jsonb, 1
);

SELECT work.adjust_budget(
  :'res_id'::uuid, -5, 'provider discount', 2
);

SELECT artifact_id, version_no
FROM work.publish_artifact(
  'org1', :'task_id'::uuid, :'run_id'::uuid,
  'draft.md', 'content://org1/task/draft-v1',
  'sha256:content-1', 128, 'text/markdown',
  '{"source":"model"}'::jsonb
) \gset

SELECT work.finish_run(:'run_id'::uuid, 'org1', 'succeeded', NULL);

-- Outbox can be claimed and marked delivered by the worker.
SELECT count(*) AS outbox_claimed FROM work.claim_outbox(100) \gset
INSERT INTO smoke_assert SELECT 'outbox_claimed', :'outbox_claimed'::int > 0;
SELECT event_id FROM work.outbox WHERE org_id = 'org1' LIMIT 1 \gset
SELECT work.mark_outbox_delivered(:'event_id'::uuid);

-- ---------------------------------------------------------------------------
-- API path: summary + acceptance
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';

SELECT display_state, pending_acceptance, reserved_cents, settled_cents
FROM work.task_summary WHERE task_id = :'task_id'::uuid \gset

INSERT INTO smoke_assert
SELECT 'summary_awaiting_acceptance', :'display_state' = 'awaiting_acceptance';
INSERT INTO smoke_assert
SELECT 'summary_budget_settled', :'reserved_cents'::bigint = 0 AND :'settled_cents'::bigint = 75;

SELECT revision AS task_rev
FROM work.task WHERE id = :'task_id'::uuid \gset

SELECT work.accept_task(
  :'task_id'::uuid, 'org1', :'artifact_id'::uuid, :'version_no'::int,
  'user1', :'task_rev'::bigint, NULL
);

INSERT INTO smoke_assert
SELECT 'task_completed', state = 'completed'
FROM work.task WHERE id = :'task_id'::uuid;

-- Duplicate acceptance is a revision/quiescence conflict.
DO $$ BEGIN
  BEGIN
    PERFORM work.accept_task(
      (SELECT id FROM work.task WHERE org_id = 'org1' ORDER BY created_at LIMIT 1),
      'org1',
      (SELECT id FROM work.artifact WHERE org_id = 'org1' LIMIT 1),
      1, 'user1',
      (SELECT revision FROM work.task WHERE org_id = 'org1' ORDER BY created_at LIMIT 1),
      NULL
    );
    RAISE EXCEPTION 'expected_duplicate_accept_conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%run_not_quiescent_or_revision_conflict%' THEN RAISE; END IF;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Approval path
-- ---------------------------------------------------------------------------
SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-2', 'sha256:input-2', 128, 'application/json'
) AS input2_id \gset

CREATE TEMP TABLE ctx2 AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-approval', 'sha256:req-approval',
  :'input2_id'::uuid, '审批路径', 'ask_each',
  'sha256:snap-approval', '{}'::jsonb,
  ARRAY['model_call']::text[],
  '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-approval', 'pi-1.4.0'
);
SELECT task_id AS task2_id, run_id AS run2_id FROM ctx2 \gset

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT state AS run2_state, fence AS fence2
FROM work.acquire_run(:'run2_id'::uuid, 'org1') \gset

SELECT work.create_operation(
  :'run2_id'::uuid, 'org1', 'tool:approval', 'tool', 'sha256:tool-1'
) AS op2_id \gset
SELECT work.reserve_budget(
  'org1', 'default', '2026-10', :'op2_id'::uuid, 50
) AS res2_id \gset

RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';

SELECT work.request_approval(
  'org1', :'op2_id'::uuid, 'sha256:params-2',
  '{"kind":"tool","scope":"read-only"}'::jsonb,
  'medium', now() + interval '10 minutes', 1
) AS approval_id \gset

SELECT work.decide_approval(
  'org1', :'approval_id'::uuid, 'user1', 'approved', 0, 'sha256:params-2'
);

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';

SELECT work.claim_dispatch(
  :'op2_id'::uuid, 'org1', 'worker-1', :'fence2'::bigint
) AS dispatch2_id \gset
INSERT INTO smoke_assert SELECT 'approval_dispatch', :'dispatch2_id'::uuid IS NOT NULL;

SELECT work.finish_operation(
  'org1', :'op2_id'::uuid, 'succeeded', 'provider-req-2', 'receipt-2'
);
SELECT work.settle_budget(
  :'res2_id'::uuid, 30, 'price-v1', '{"calls":1}'::jsonb, 1
);
SELECT work.finish_run(:'run2_id'::uuid, 'org1', 'succeeded', NULL);

RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';
SELECT revision AS task2_rev
FROM work.task WHERE id = :'task2_id'::uuid \gset

SELECT work.accept_task(
  :'task2_id'::uuid, 'org1', NULL, NULL, 'user1',
  :'task2_rev'::bigint, 'no artifact required'
);
INSERT INTO smoke_assert
SELECT 'approval_task_completed', state = 'completed'
FROM work.task WHERE id = :'task2_id'::uuid;

-- ---------------------------------------------------------------------------
-- Cancel + retry path
-- ---------------------------------------------------------------------------
SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-3', 'sha256:input-3', 128, 'application/json'
) AS input3_id \gset

CREATE TEMP TABLE ctx3 AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-cancel', 'sha256:req-cancel',
  :'input3_id'::uuid, '取消路径', 'ask_each',
  'sha256:snap-cancel', '{}'::jsonb,
  ARRAY['model_call']::text[],
  '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-cancel', 'pi-1.4.0'
);
SELECT task_id AS task3_id, run_id AS run3_id FROM ctx3 \gset

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT state AS run3_state, fence AS fence3
FROM work.acquire_run(:'run3_id'::uuid, 'org1') \gset
SELECT work.create_operation(
  :'run3_id'::uuid, 'org1', 'model:cancel', 'model', 'sha256:model-cancel'
) AS op3_id \gset
SELECT work.authorize_operation('org1', :'op3_id'::uuid, 1, 'policy_auto');
SELECT work.reserve_budget(
  'org1', 'default', '2026-10', :'op3_id'::uuid, 20
) AS res3_id \gset

RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';
SELECT work.request_cancel('org1', :'run3_id'::uuid, 'user1', 'user canceled');

INSERT INTO smoke_assert
SELECT 'cancel_signal_outbox', count(*) = 1
FROM work.outbox
WHERE org_id = 'org1'
  AND aggregate_type = 'run'
  AND aggregate_id = :'run3_id'::uuid
  AND payload->>'kind' = 'cancel_signal';

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT work.cancel_operation('org1', :'op3_id'::uuid, 'user1', 'user canceled');
SELECT work.finish_run(:'run3_id'::uuid, 'org1', 'canceled', 'user canceled');

RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';
SELECT display_state, reserved_cents
FROM work.task_summary WHERE task_id = :'task3_id'::uuid \gset
INSERT INTO smoke_assert
SELECT 'cancel_summary', :'display_state' = 'run_canceled' AND :'reserved_cents'::bigint = 0;

SELECT snapshot_id AS task3_snapshot
FROM work.task WHERE id = :'task3_id'::uuid \gset
SELECT work.create_run(
  :'task3_id'::uuid, 'org1', :'task3_snapshot'::uuid,
  'wf-cancel-retry', 'pi-1.4.0'
) AS retry_run_id \gset
INSERT INTO smoke_assert
SELECT 'retry_run_created', :'retry_run_id'::uuid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Wait/resume + unknown/reconcile path
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';

SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-4', 'sha256:input-4', 128, 'application/json'
) AS input4_id \gset

CREATE TEMP TABLE ctx4 AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-unknown-0001', 'sha256:req-unknown',
  :'input4_id'::uuid, '未知对账路径', 'ask_each',
  'sha256:snap-unknown', '{}'::jsonb,
  ARRAY['model_call']::text[],
  '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-unknown', 'pi-1.4.0'
);
SELECT task_id AS task4_id, run_id AS run4_id FROM ctx4 \gset

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT state AS run4_state, fence AS fence4
FROM work.acquire_run(:'run4_id'::uuid, 'org1') \gset
INSERT INTO smoke_assert SELECT 'run4_active', :'run4_state' = 'active';

SELECT work.wait_run('org1', :'run4_id'::uuid, 'budget');
INSERT INTO smoke_assert
SELECT 'run_waiting_budget', state = 'waiting' AND wait_reason = 'budget'
FROM work.run WHERE id = :'run4_id'::uuid;

SELECT work.resume_run('org1', :'run4_id'::uuid);
INSERT INTO smoke_assert
SELECT 'run_resumed', state = 'active' AND wait_reason IS NULL
FROM work.run WHERE id = :'run4_id'::uuid;

SELECT work.create_operation(
  :'run4_id'::uuid, 'org1', 'model:unknown', 'model', 'sha256:unknown-1'
) AS op4_id \gset
SELECT work.authorize_operation('org1', :'op4_id'::uuid, 1, 'policy_auto');
SELECT work.reserve_budget(
  'org1', 'default', '2026-10', :'op4_id'::uuid, 30
) AS res4_id \gset
SELECT work.claim_dispatch(
  :'op4_id'::uuid, 'org1', 'worker-1', :'fence4'::bigint
) AS dispatch4_id \gset

SELECT work.mark_operation_unknown('org1', :'op4_id'::uuid, 'provider timeout');
INSERT INTO smoke_assert
SELECT 'unknown_retained_budget', state = 'unknown'
FROM work.operation WHERE id = :'op4_id'::uuid;
INSERT INTO smoke_assert
SELECT 'unknown_reserved', reserved_cents = 30
FROM work.budget_account
WHERE org_id = 'org1' AND account_key = 'default' AND period_id = '2026-10';

SELECT work.reconcile_operation(
  'org1', :'op4_id'::uuid, 'not_sent',
  NULL, 0, 'price-v1', 'evidence://not-sent'
);
INSERT INTO smoke_assert
SELECT 'reconcile_not_sent_operation', state = 'reconciled'
FROM work.operation WHERE id = :'op4_id'::uuid;
INSERT INTO smoke_assert
SELECT 'reconcile_not_sent_released', reserved_cents = 0
FROM work.budget_account
WHERE org_id = 'org1' AND account_key = 'default' AND period_id = '2026-10';

SELECT work.finish_run(:'run4_id'::uuid, 'org1', 'failed', 'reconciled_not_sent');
INSERT INTO smoke_assert
SELECT 'run4_task_open', state = 'open'
FROM work.task WHERE id = :'task4_id'::uuid;

-- Confirmed-sent path: settle the reserved amount and finish successfully.
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';
SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-5', 'sha256:input-5', 128, 'application/json'
) AS input5_id \gset
CREATE TEMP TABLE ctx5 AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-reconcile-0001', 'sha256:req-reconcile',
  :'input5_id'::uuid, '确认已发送路径', 'ask_each',
  'sha256:snap-reconcile', '{}'::jsonb,
  ARRAY['model_call']::text[],
  '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-reconcile', 'pi-1.4.0'
);
SELECT task_id AS task5_id, run_id AS run5_id FROM ctx5 \gset

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT state AS run5_state, fence AS fence5
FROM work.acquire_run(:'run5_id'::uuid, 'org1') \gset
SELECT work.create_operation(
  :'run5_id'::uuid, 'org1', 'model:sent', 'model', 'sha256:sent-1'
) AS op5_id \gset
SELECT work.authorize_operation('org1', :'op5_id'::uuid, 1, 'policy_auto');
SELECT work.reserve_budget(
  'org1', 'default', '2026-10', :'op5_id'::uuid, 40
) AS res5_id \gset
SELECT work.claim_dispatch(
  :'op5_id'::uuid, 'org1', 'worker-1', :'fence5'::bigint
) AS dispatch5_id \gset
SELECT work.mark_operation_unknown('org1', :'op5_id'::uuid, 'receipt lost');
SELECT work.reconcile_operation(
  'org1', :'op5_id'::uuid, 'sent_succeeded',
  'provider-req-5', 25, 'price-v1', 'evidence://provider-5'
);
INSERT INTO smoke_assert
SELECT 'reconcile_sent_operation', state = 'reconciled'
FROM work.operation WHERE id = :'op5_id'::uuid;
INSERT INTO smoke_assert
SELECT 'reconcile_sent_amount', COALESCE(SUM(amount_cents), 0) = 25
FROM work.budget_entry
WHERE operation_id = :'op5_id'::uuid AND kind IN ('settle', 'adjust');
INSERT INTO smoke_assert
SELECT 'reconcile_sent_reserved_zero', reserved_cents = 0
FROM work.budget_account
WHERE org_id = 'org1' AND account_key = 'default' AND period_id = '2026-10';

SELECT work.finish_run(:'run5_id'::uuid, 'org1', 'succeeded', NULL);
INSERT INTO smoke_assert
SELECT 'run5_awaiting', state = 'awaiting_acceptance'
FROM work.task WHERE id = :'task5_id'::uuid;

-- ---------------------------------------------------------------------------
-- Title edit + artifact export audit (D2 gap closure)
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';

SELECT revision AS title_rev0 FROM work.task WHERE id = :'task_id'::uuid \gset
SELECT work.update_task_title('org1', :'task_id'::uuid, 'user1', 'req-title-0001', :'title_rev0'::bigint, '  季度复盘  ') AS title_rev1 \gset
SELECT work.update_task_title('org1', :'task_id'::uuid, 'user1', 'req-title-0001', :'title_rev0'::bigint, '季度复盘') AS title_rev1_replay \gset
INSERT INTO smoke_assert
SELECT 'title_update_trimmed', title = '季度复盘' AND revision = :'title_rev0'::bigint + 1
FROM work.task WHERE id = :'task_id'::uuid;
INSERT INTO smoke_assert
SELECT 'title_update_idempotent', :'title_rev1'::bigint = :'title_rev1_replay'::bigint;
INSERT INTO smoke_assert
SELECT 'title_event_no_text', count(*) = 1 AND bool_and(payload::text NOT LIKE '%季度复盘%')
FROM work.task_event WHERE task_id = :'task_id'::uuid AND type = 'task.updated';

DO $$
DECLARE
  tid uuid := (SELECT id FROM work.task WHERE org_id = 'org1' AND title = '季度复盘');
  cases text[][] := ARRAY[
    ARRAY['req-title-0001', '0', '另一个标题', 'idempotency_key_conflict'],
    ARRAY['req-title-0002', '0', '旧 revision', 'version_conflict'],
    ARRAY['req-title-0003', '-1', E'bad\x07title', 'title_invalid'],
    ARRAY['req-title-0004', '-1', repeat('长', 81), 'title_invalid']
  ];
  c text[];
BEGIN
  FOREACH c SLICE 1 IN ARRAY cases LOOP
    BEGIN
      PERFORM work.update_task_title('org1', tid, 'user1', c[1],
        CASE WHEN c[2] = '-1' THEN (SELECT revision FROM work.task WHERE id = tid) ELSE c[2]::bigint END,
        c[3]);
      RAISE EXCEPTION 'expected_%', c[4];
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> c[4] THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM work.update_task_title('org1', tid, 'intruder', 'req-title-0005',
      (SELECT revision FROM work.task WHERE id = tid), '越权');
    RAISE EXCEPTION 'expected_not_owner';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'title_update_negatives', true;

SELECT work.record_artifact_export('org1', :'artifact_id'::uuid, :'version_no'::int, 'user1') AS export_audit_id \gset
INSERT INTO smoke_assert
SELECT 'artifact_export_audit',
  count(*) = 1
  AND bool_and(action = 'artifact.exported')
  AND bool_and(metadata ? 'content_hash')
  AND bool_and(NOT metadata ? 'content')
FROM work.audit_event WHERE id = :'export_audit_id'::uuid;

DO $$ BEGIN
  BEGIN
    PERFORM work.record_artifact_export('org1',
      (SELECT id FROM work.artifact WHERE org_id = 'org1' LIMIT 1), 999, 'user1');
    RAISE EXCEPTION 'expected_version_not_found';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'version_not_found' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'artifact_export_missing_version', true;

-- ---------------------------------------------------------------------------
-- Outbox per-aggregate ordering, backoff and dead letter (D3 §15-6)
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL app.org_id = 'org1';
UPDATE work.outbox SET delivered_at = now() WHERE delivered_at IS NULL;
INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
VALUES
  ('org1', 'run', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', '{"kind":"start_workflow"}'),
  ('org1', 'run', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e2', '{"kind":"cancel_signal"}'),
  ('org1', 'run', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e3', '{"kind":"start_workflow"}');

SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'outbox_head_of_line',
  array_agg(event_id::text ORDER BY outbox_seq) = ARRAY[
    '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e3']
FROM work.claim_outbox(10);

SELECT work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e1', 'temporal_unavailable', true) AS fail1 \gset
INSERT INTO smoke_assert
SELECT 'outbox_backoff_blocks_aggregate',
  :'fail1' = 'retry_scheduled'
  AND NOT EXISTS (
    SELECT 1 FROM work.claim_outbox(10)
    WHERE aggregate_id = '00000000-0000-0000-0000-0000000000a1');

SELECT work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e1', 'payload_invalid', false) AS fail2 \gset
INSERT INTO smoke_assert
SELECT 'outbox_dead_letter_unblocks_next',
  :'fail2' = 'dead_letter'
  AND EXISTS (
    SELECT 1 FROM work.claim_outbox(10)
    WHERE event_id = '00000000-0000-0000-0000-0000000000e2');

RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'outbox_dead_letter_audited', count(*) = 1
FROM work.audit_event
WHERE action = 'outbox.dead_lettered' AND metadata->>'error_code' = 'payload_invalid';

DO $$ BEGIN
  BEGIN
    PERFORM work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e3', 'Bad Code!', true);
    RAISE EXCEPTION 'expected_invalid_request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'invalid_request' THEN RAISE; END IF;
  END;
END $$;

SET LOCAL ROLE work_ops;
SET LOCAL app.org_id = 'org1';
SELECT work.requeue_outbox_dead_letter('00000000-0000-0000-0000-0000000000e1', 'ops:oncall', 'payload fixed upstream');
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'outbox_requeue_audited',
  (SELECT dead_lettered_at IS NULL AND attempts = 0 FROM work.outbox
     WHERE event_id = '00000000-0000-0000-0000-0000000000e1')
  AND EXISTS (SELECT 1 FROM work.audit_event WHERE action = 'outbox.requeued');
INSERT INTO smoke_assert
SELECT 'outbox_requeue_not_granted_to_worker',
  NOT has_function_privilege('work_worker', 'work.requeue_outbox_dead_letter(uuid, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_api', 'work.requeue_outbox_dead_letter(uuid, text, text)', 'EXECUTE')
  AND NOT has_table_privilege('work_ops', 'work.outbox', 'UPDATE');

-- ---------------------------------------------------------------------------
-- Deletion + ownership transfer (C27/C30 design closure)
-- ---------------------------------------------------------------------------
RESET ROLE;
INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
VALUES ('org1', 'user3', 'active', 'member', true),
       ('org1', 'user4', 'active', 'member', false);
SET LOCAL ROLE work_api;
SET LOCAL app.org_id = 'org1';

SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-del', 'sha256:input-del', 64, 'application/json'
) AS del_input \gset
SELECT task_id AS busy_task FROM work.submit_task(
  'org1', 'user1', 'req-del-busy', 'sha256:req-del-busy',
  :'del_input'::uuid, '进行中任务', 'ask_each', 'sha256:snap-del',
  '{"template":null}'::jsonb,
  ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-req-del-busy', 'pi-1.4.0'
) \gset

DO $$ BEGIN
  BEGIN
    PERFORM work.delete_task('org1', (SELECT id FROM work.task WHERE title = '进行中任务'), 'user1', 'cleanup');
    RAISE EXCEPTION 'expected_run_not_quiescent';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'run_not_quiescent' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.delete_task('org1', (SELECT id FROM work.task WHERE title = '季度复盘'), 'user2', 'not mine');
    RAISE EXCEPTION 'expected_task_not_found';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'delete_requires_quiescent_owner', true;

SELECT work.delete_task('org1', :'task_id'::uuid, 'user1', 'user request') AS shred_refs \gset
SELECT work.delete_task('org1', :'task_id'::uuid, 'user1', 'user request') AS shred_refs_again \gset
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'delete_tombstones_task',
  t.deleted_at IS NOT NULL AND t.title = '[deleted]'
  AND NOT EXISTS (SELECT 1 FROM work.artifact a WHERE a.task_id = t.id AND a.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM work.artifact_tombstone tb JOIN work.artifact a ON a.id = tb.artifact_id WHERE a.task_id = t.id)
  AND :'shred_refs'::int >= 1 AND :'shred_refs_again'::int = 0
FROM work.task t WHERE t.id = :'task_id'::uuid;
INSERT INTO smoke_assert
SELECT 'delete_shred_outbox_refs_only',
  count(*) = 1
  AND bool_and(jsonb_typeof(payload->'content_refs') = 'array')
  AND bool_and(payload::text NOT LIKE '%季度复盘%')
FROM work.outbox WHERE aggregate_type = 'content' AND aggregate_id = :'task_id'::uuid;
INSERT INTO smoke_assert
SELECT 'delete_keeps_ledger_and_marks_dedup',
  EXISTS (SELECT 1 FROM work.budget_entry e JOIN work.operation o ON o.id = e.operation_id
          JOIN work.run r ON r.id = o.run_id WHERE r.task_id = :'task_id'::uuid)
  AND NOT EXISTS (SELECT 1 FROM work.submission_dedup WHERE task_id = :'task_id'::uuid AND NOT task_deleted);
INSERT INTO smoke_assert
SELECT 'delete_exports_blocked', NOT EXISTS (
  SELECT 1 FROM work.artifact WHERE task_id = :'task_id'::uuid AND deleted_at IS NULL);

CREATE TEMP TABLE ops_ids AS
SELECT
  (SELECT id FROM work.task WHERE title = '进行中任务') AS busy_id,
  (SELECT id FROM work.task t
   WHERE t.deleted_at IS NULL AND t.active_run_id IS NULL AND t.owner_subject_id = 'user1'
     AND NOT EXISTS (SELECT 1 FROM work.operation o JOIN work.run r ON r.id = o.run_id
                     WHERE r.task_id = t.id
                       AND o.state IN ('prepared','waiting_approval','authorized','dispatching','unknown','unresolved'))
   ORDER BY t.created_at LIMIT 1) AS xfer_id;
GRANT SELECT ON ops_ids TO work_ops;
SELECT xfer_id AS xfer_task FROM ops_ids \gset

SET LOCAL ROLE work_ops;
SET LOCAL app.org_id = 'org1';
DO $$ BEGIN
  BEGIN
    PERFORM work.transfer_task_ownership('org1', (SELECT xfer_id FROM ops_ids), 'user4', 'ops:oncall', 'SUP-101', 'owner left');
    RAISE EXCEPTION 'expected_work_seat_required';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'work_seat_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.transfer_task_ownership('org1', (SELECT busy_id FROM ops_ids), 'user3', 'ops:oncall', 'SUP-103', 'owner left');
    RAISE EXCEPTION 'expected_run_not_quiescent';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'run_not_quiescent' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.transfer_task_ownership('org1', (SELECT xfer_id FROM ops_ids), 'user3', 'ops:oncall', 'no-ticket', 'owner left');
    RAISE EXCEPTION 'expected_invalid_request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'invalid_request' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.ops_delete_task('org1', (SELECT busy_id FROM ops_ids), 'ops:oncall', 'LEGAL-7', 'erasure request');
    RAISE EXCEPTION 'expected_run_not_quiescent';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'run_not_quiescent' THEN RAISE; END IF;
  END;
END $$;
SELECT work.transfer_task_ownership('org1', :'xfer_task'::uuid, 'user3', 'ops:oncall', 'SUP-102', 'owner left org') AS xfer_rev \gset
SELECT work.ops_delete_task('org1', :'xfer_task'::uuid, 'ops:oncall', 'LEGAL-7', 'erasure request') AS ops_del_refs \gset
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'ownership_transfer_audited',
  (SELECT owner_subject_id = 'user3' FROM work.task WHERE id = :'xfer_task'::uuid)
  AND EXISTS (SELECT 1 FROM work.audit_event WHERE action = 'task.ownership_transferred'
              AND metadata->>'ticket_ref' = 'SUP-102' AND metadata->>'from' = 'user1')
  AND EXISTS (SELECT 1 FROM work.task_event WHERE task_id = :'xfer_task'::uuid AND type = 'task.owner_changed');
INSERT INTO smoke_assert
SELECT 'ops_delete_audited',
  (SELECT deleted_at IS NOT NULL FROM work.task WHERE id = :'xfer_task'::uuid)
  AND EXISTS (SELECT 1 FROM work.audit_event WHERE action = 'task.deleted_by_ops'
              AND target_id = :'xfer_task' AND metadata->>'reason' LIKE 'LEGAL-7:%');
INSERT INTO smoke_assert
SELECT 'ops_privileges_scoped',
  NOT has_function_privilege('work_api', 'work.transfer_task_ownership(text, uuid, text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_api', 'work.ops_delete_task(text, uuid, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_api', 'work.delete_task_core(text, uuid, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_ops', 'work.delete_task_core(text, uuid, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_ops', 'work.submit_task(text, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, text, text, text)', 'EXECUTE');

-- ---------------------------------------------------------------------------
-- Lifecycle events for SSE/metrics (triggers)
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'event_run_succeeded', count(*) >= 1 FROM work.task_event WHERE type = 'run.succeeded';
INSERT INTO smoke_assert
SELECT 'event_task_awaiting', count(*) >= 1 FROM work.task_event WHERE type = 'task.awaiting_acceptance';
INSERT INTO smoke_assert
SELECT 'event_task_completed_no_text',
  count(*) >= 1 AND bool_and(payload ? 'basis') AND bool_and(NOT payload ? 'completion_reason')
FROM work.task_event WHERE type = 'task.completed';
INSERT INTO smoke_assert
SELECT 'event_seq_contiguous', bool_and(ok) FROM (
  SELECT max(seq) = count(*) AS ok FROM work.task_event GROUP BY task_id
) s;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM smoke_assert WHERE NOT ok) THEN
    RAISE EXCEPTION 'smoke assertions failed: %',
      (SELECT string_agg(name, ', ' ORDER BY name) FROM smoke_assert WHERE NOT ok);
  END IF;
END $$;

SELECT name, ok FROM smoke_assert ORDER BY name;

ROLLBACK;
