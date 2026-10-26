-- R0a schema smoke test
-- Run after r0a-schema-draft.sql in a disposable PostgreSQL 16 database.
-- Covers: input/task submission, idempotency, session-subject binding, scope rejection, direct-DML denial,
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
SET LOCAL app.subject_id = 'user1';

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
  'org1', 'user1', 'req-0001',
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
  'org1', 'user1', 'req-0001',
  :'input_id'::uuid, '测试方案', 'ask_each',
  'sha256:snap-001',
  '{"template":{"id":"tpl-report","version":1,"content_hash":"sha256:tpl-1"},"limits":{"goal":2000,"background":4000}}'::jsonb,
  ARRAY['model_call', 'read_builtin_template', 'write_artifact_draft']::text[],
  '{"provider":"qwen","model":"qwen3.8-flash"}'::jsonb,
  'price-v1', 'wf-req-0001', 'pi-1.4.0'
);

INSERT INTO smoke_assert
SELECT 'one_task_after_retry', count(*) = 1 FROM work.task;

RESET ROLE;
INSERT INTO smoke_assert
SELECT 'dedup_row', count(*) = 1 FROM work.submission_dedup;

INSERT INTO smoke_assert
SELECT 'workflow_start_outbox', count(*) = 1
FROM work.outbox
WHERE org_id = 'org1'
  AND aggregate_type = 'run'
  AND aggregate_id = :'run_id'::uuid
  AND payload->>'kind' = 'start_workflow';
INSERT INTO smoke_assert
SELECT 'input_bound_to_task', task_id = :'task_id'::uuid FROM work.input_object WHERE id = :'input_id'::uuid;
SET LOCAL ROLE work_api;

-- Same key, different payload -> conflict (server-side request hash).
DO $$ BEGIN
  BEGIN
    PERFORM 1
    FROM work.submit_task(
      'org1', 'user1', 'req-0001',
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
      'org1', 'user1', 'req-0002',
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
      'org1', 'user1', 'req-0003',
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

SELECT has_table_privilege('work_ledger', 'work.budget_entry', 'SELECT')
   AND NOT has_table_privilege('work_ledger', 'work.budget_entry', 'INSERT')
   AND NOT has_table_privilege('work_ledger', 'work.budget_entry', 'UPDATE')
   AND NOT has_table_privilege('work_ledger', 'work.budget_entry', 'DELETE')
   AND NOT has_table_privilege('work_ledger', 'work.audit_event', 'INSERT')
   AND NOT has_table_privilege('work_ledger', 'work.task_event', 'INSERT')
   AND NOT has_table_privilege('work_ledger', 'work.task', 'INSERT') AS ledger_ok \gset
INSERT INTO smoke_assert SELECT 'ledger_read_only', :'ledger_ok'::boolean;
SELECT NOT has_table_privilege('work_api', 'work.outbox', 'SELECT')
   AND NOT has_table_privilege('work_api', 'work.submission_dedup', 'SELECT') AS api_no_outbox \gset
INSERT INTO smoke_assert SELECT 'api_no_outbox_or_dedup_read', :'api_no_outbox'::boolean;

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

-- 活动重试（结果丢失后重放）返回相同结果，不报错、不重复记账。
SELECT fence AS fence_replay FROM work.acquire_run(:'run_id'::uuid, 'org1') \gset
SELECT work.reserve_budget('org1', 'default', '2026-10', :'op_id'::uuid, 100) AS res_replay \gset
SELECT work.claim_dispatch(:'op_id'::uuid, 'org1', 'worker-1', :'fence'::bigint) AS dispatch_replay \gset
SELECT COALESCE(work.claim_dispatch(:'op_id'::uuid, 'org1', 'worker-2', :'fence'::bigint)::text, 'none') AS dispatch_other \gset
INSERT INTO smoke_assert
SELECT 'worker_replay_idempotent',
  :'fence_replay'::bigint = :'fence'::bigint
  AND :'res_replay'::uuid = :'res_id'::uuid
  AND :'dispatch_replay'::uuid = :'dispatch_id'::uuid
  AND :'dispatch_other' = 'none'
  AND (SELECT count(*) FROM work.budget_reservation WHERE operation_id = :'op_id'::uuid) = 1;

SELECT work.finish_operation(
  'org1', :'op_id'::uuid, 'succeeded', 'provider-req-1', 'receipt-1'
);
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
SELECT artifact_id AS artifact_replay, version_no AS version_replay
FROM work.publish_artifact(
  'org1', :'task_id'::uuid, :'run_id'::uuid,
  'draft.md', 'content://org1/task/draft-v1',
  'sha256:content-1', 128, 'text/markdown',
  '{"source":"model"}'::jsonb
) \gset
INSERT INTO smoke_assert
SELECT 'publish_replay_idempotent',
  :'artifact_replay'::uuid = :'artifact_id'::uuid AND :'version_replay'::int = :'version_no'::int
  AND (SELECT count(*) FROM work.artifact_version WHERE artifact_id = :'artifact_id'::uuid) = 1;

SELECT work.finish_run(:'run_id'::uuid, 'org1', 'succeeded', NULL);
SELECT work.finish_run(:'run_id'::uuid, 'org1', 'succeeded', NULL);

-- Outbox can be claimed and marked delivered by the worker (lease holder).
CREATE TEMP TABLE claimed1 AS SELECT * FROM work.claim_outbox('relay-a', 100, 60);
INSERT INTO smoke_assert SELECT 'outbox_claimed', count(*) > 0 FROM claimed1;
SELECT event_id FROM claimed1 ORDER BY outbox_seq LIMIT 1 \gset
SELECT work.mark_outbox_delivered(:'event_id'::uuid, 'relay-a');

-- ---------------------------------------------------------------------------
-- API path: summary + acceptance
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';

SELECT display_state, pending_acceptance, reserved_cents, settled_cents
FROM work.task_summary WHERE task_id = :'task_id'::uuid \gset

INSERT INTO smoke_assert
SELECT 'summary_awaiting_acceptance', :'display_state' = 'awaiting_acceptance';
INSERT INTO smoke_assert
SELECT 'summary_budget_settled', :'reserved_cents'::bigint = 0 AND :'settled_cents'::bigint = 75;

SELECT revision AS task_rev
FROM work.task WHERE id = :'task_id'::uuid \gset

-- 非 owner 与会话主体不一致都不能采纳。
DO $$ BEGIN
  BEGIN
    PERFORM work.accept_task('org1', (SELECT id FROM work.task WHERE title = '测试方案'), 'user9',
      'req-accept-x1', 1, NULL, NULL, 'not mine');
    RAISE EXCEPTION 'expected_actor_mismatch';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'actor_mismatch' THEN RAISE; END IF;
  END;
END $$;

SELECT acceptance_id AS acc1 FROM work.accept_task(
  'org1', :'task_id'::uuid, 'user1', 'req-accept-0001', :'task_rev'::bigint,
  :'artifact_id'::uuid, :'version_no'::int, NULL
) \gset
SELECT acceptance_id AS acc1_replay FROM work.accept_task(
  'org1', :'task_id'::uuid, 'user1', 'req-accept-0001', :'task_rev'::bigint,
  :'artifact_id'::uuid, :'version_no'::int, NULL
) \gset

INSERT INTO smoke_assert
SELECT 'task_completed', state = 'completed'
FROM work.task WHERE id = :'task_id'::uuid;
INSERT INTO smoke_assert
SELECT 'accept_replay_idempotent', :'acc1'::uuid = :'acc1_replay'::uuid
  AND (SELECT count(*) FROM work.acceptance WHERE task_id = :'task_id'::uuid) = 1;

-- 新键 + 旧 revision → version_conflict；新键 + 当前 revision → task_not_acceptable（已完成）。
DO $$
DECLARE tid uuid := (SELECT id FROM work.task WHERE title = '测试方案');
BEGIN
  BEGIN
    PERFORM work.accept_task('org1', tid, 'user1', 'req-accept-0002', 1, NULL, NULL, 'again');
    RAISE EXCEPTION 'expected_version_conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'version_conflict' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.accept_task('org1', tid, 'user1', 'req-accept-0003',
      (SELECT revision FROM work.task WHERE id = tid), NULL, NULL, 'again');
    RAISE EXCEPTION 'expected_task_not_acceptable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_acceptable' THEN RAISE; END IF;
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
  'org1', 'user1', 'req-approval',
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

SELECT work.request_approval(
  'org1', :'op2_id'::uuid, 'sha256:params-2',
  '{"kind":"tool","scope":"read-only"}'::jsonb,
  'medium', now() + interval '10 minutes', 1
) AS approval_id \gset
SELECT work.request_approval(
  'org1', :'op2_id'::uuid, 'sha256:params-2',
  '{"kind":"tool","scope":"read-only"}'::jsonb,
  'medium', now() + interval '10 minutes', 1
) AS approval_replay \gset
INSERT INTO smoke_assert SELECT 'approval_request_replay', :'approval_id'::uuid = :'approval_replay'::uuid;

RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';

-- 非 owner 不能审批（会话主体换成同组织其他人）。
DO $$ BEGIN
  PERFORM set_config('app.subject_id', 'user2', true);
  BEGIN
    PERFORM work.decide_approval('org1', (SELECT approval_id FROM work.approval_operation LIMIT 1),
      'user2', 'approved', 0, 'sha256:params-2');
    RAISE EXCEPTION 'expected_approval_not_found';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'approval_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.subject_id', 'user1', true);
END $$;
INSERT INTO smoke_assert SELECT 'approval_owner_only', true;

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
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT revision AS task2_rev
FROM work.task WHERE id = :'task2_id'::uuid \gset

SELECT acceptance_id AS acc2 FROM work.accept_task(
  'org1', :'task2_id'::uuid, 'user1', 'req-accept-0101',
  :'task2_rev'::bigint, NULL, NULL, 'no artifact required'
) \gset
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
  'org1', 'user1', 'req-cancel',
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
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
DO $$ BEGIN
  BEGIN
    PERFORM work.request_cancel('org1', (SELECT id FROM work.run WHERE workflow_id = 'wf-cancel'), 'user1', 'free text reason');
    RAISE EXCEPTION 'expected_invalid_reason_code';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'invalid_reason_code' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.subject_id', 'user9', true);
  BEGIN
    PERFORM work.request_cancel('org1', (SELECT id FROM work.run WHERE workflow_id = 'wf-cancel'), 'user9', 'user_requested');
    RAISE EXCEPTION 'expected_run_not_found';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'run_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.subject_id', 'user1', true);
END $$;
INSERT INTO smoke_assert SELECT 'cancel_owner_and_reason_code', true;
SELECT work.request_cancel('org1', :'run3_id'::uuid, 'user1', 'user_requested');

RESET ROLE;
INSERT INTO smoke_assert
SELECT 'cancel_signal_outbox', count(*) = 1
FROM work.outbox
WHERE org_id = 'org1'
  AND aggregate_type = 'run'
  AND aggregate_id = :'run3_id'::uuid
  AND payload->>'kind' = 'cancel_signal';
INSERT INTO smoke_assert
SELECT 'events_reason_codes_only', bool_and(coalesce(payload->>'reason', 'x') ~ '^[a-z][a-z0-9_]*$')
FROM work.task_event WHERE payload ? 'reason';

RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT work.cancel_operation('org1', :'op3_id'::uuid, 'system:worker', 'user_requested');
SELECT work.finish_run(:'run3_id'::uuid, 'org1', 'canceled', 'user_requested');

RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT display_state, reserved_cents
FROM work.task_summary WHERE task_id = :'task3_id'::uuid \gset
INSERT INTO smoke_assert
SELECT 'cancel_summary', :'display_state' = 'run_canceled' AND :'reserved_cents'::bigint = 0;

SELECT revision AS task3_rev FROM work.task_summary WHERE task_id = :'task3_id'::uuid \gset
DO $$
DECLARE tid uuid := (SELECT id FROM work.task WHERE title = '取消路径');
BEGIN
  BEGIN
    PERFORM work.retry_task('org1', tid, 'user1', 'req-retry-stale',
      (SELECT revision FROM work.task WHERE id = tid) - 1, 'wf-stale-retry', 'pi-1.4.0');
    RAISE EXCEPTION 'expected_version_conflict_retry';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'version_conflict' THEN RAISE; END IF;
  END;
END $$;
SELECT run_id AS retry_run_id FROM work.retry_task(
  'org1', :'task3_id'::uuid, 'user1', 'req-retry-0001', :'task3_rev'::bigint,
  'wf-cancel-retry', 'pi-1.4.0'
) \gset
SELECT run_id AS retry_run_replay FROM work.retry_task(
  'org1', :'task3_id'::uuid, 'user1', 'req-retry-0001', :'task3_rev'::bigint,
  'wf-cancel-retry', 'pi-1.4.0'
) \gset
DO $$ BEGIN
  BEGIN
    PERFORM work.retry_task('org1', (SELECT task_id FROM work.task_summary WHERE title = '取消路径'),
      'user1', 'req-retry-0002', (SELECT revision FROM work.task_summary WHERE title = '取消路径'),
      'wf-cancel-retry-2', 'pi-1.4.0');
    RAISE EXCEPTION 'expected_task_has_active_run';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_has_active_run' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
INSERT INTO smoke_assert
SELECT 'retry_run_created',
  :'retry_run_id'::uuid IS NOT NULL AND :'retry_run_id'::uuid = :'retry_run_replay'::uuid
  AND EXISTS (SELECT 1 FROM work.outbox WHERE aggregate_id = :'retry_run_id'::uuid
              AND payload->>'kind' = 'start_workflow')
  AND (SELECT attempt_no FROM work.run WHERE id = :'retry_run_id'::uuid) = 2;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';

-- ---------------------------------------------------------------------------
-- Wait/resume + unknown/reconcile path
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';

SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-4', 'sha256:input-4', 128, 'application/json'
) AS input4_id \gset

CREATE TEMP TABLE ctx4 AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-unknown-0001',
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

SELECT work.mark_operation_unknown('org1', :'op4_id'::uuid, 'provider_timeout');
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
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-5', 'sha256:input-5', 128, 'application/json'
) AS input5_id \gset
CREATE TEMP TABLE ctx5 AS
SELECT *
FROM work.submit_task(
  'org1', 'user1', 'req-reconcile-0001',
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
SELECT work.mark_operation_unknown('org1', :'op5_id'::uuid, 'receipt_lost');
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
SET LOCAL app.subject_id = 'user1';
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
  PERFORM set_config('app.subject_id', 'intruder', true);
  BEGIN
    PERFORM work.update_task_title('org1', tid, 'intruder', 'req-title-0005',
      (SELECT revision FROM work.task WHERE id = tid), '越权');
    RAISE EXCEPTION 'expected_not_owner';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.update_task_title('org1', tid, 'user1', 'req-title-0006',
      (SELECT revision FROM work.task WHERE id = tid), '冒用');
    RAISE EXCEPTION 'expected_actor_mismatch';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'actor_mismatch' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.subject_id', 'user1', true);
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
-- Outbox: per-aggregate ordering, lease, backoff, dead letter keeps blocking,
-- ops requeue/skip, multi-org relay, start_workflow dead letter fails the run
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL app.org_id = 'org1';
UPDATE work.outbox SET delivered_at = now() WHERE delivered_at IS NULL;
INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
VALUES
  ('org1', 'run', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', '{"kind":"start_workflow"}'),
  ('org1', 'run', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e2', '{"kind":"cancel_signal"}'),
  ('org1', 'run', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e3', '{"kind":"start_workflow"}'),
  ('org2', 'run', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e4', '{"kind":"start_workflow"}');

-- Relay runs without a tenant context and still sees every org (via definer functions only).
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = '';
CREATE TEMP TABLE c1 AS SELECT * FROM work.claim_outbox('relay-a', 10, 60);
INSERT INTO smoke_assert
SELECT 'outbox_head_of_line_multi_org',
  array_agg(event_id::text ORDER BY outbox_seq) = ARRAY[
    '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e3',
    '00000000-0000-0000-0000-0000000000e4']
FROM c1;
INSERT INTO smoke_assert
SELECT 'outbox_lease_exclusive', count(*) = 0 FROM work.claim_outbox('relay-b', 10, 60);
DO $$ BEGIN
  BEGIN
    PERFORM work.mark_outbox_delivered('00000000-0000-0000-0000-0000000000e1', 'relay-b');
    RAISE EXCEPTION 'expected_outbox_lease_lost';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'outbox_lease_lost' THEN RAISE; END IF;
  END;
END $$;
SELECT set_config('app.outbox_relay', 'on', true);
INSERT INTO smoke_assert
SELECT 'outbox_relay_scope_definer_only', count(*) = 0 FROM work.outbox WHERE org_id = 'org2';
SELECT set_config('app.outbox_relay', 'off', true);

SELECT work.mark_outbox_delivered('00000000-0000-0000-0000-0000000000e3', 'relay-a');
SELECT work.mark_outbox_delivered('00000000-0000-0000-0000-0000000000e4', 'relay-a');

SELECT work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e1', 'relay-a', 'temporal_unavailable', true) AS fail1 \gset
INSERT INTO smoke_assert
SELECT 'outbox_backoff_blocks_aggregate',
  :'fail1' = 'retry_scheduled'
  AND NOT EXISTS (
    SELECT 1 FROM work.claim_outbox('relay-a', 10, 60)
    WHERE aggregate_id = '00000000-0000-0000-0000-0000000000a1');

RESET ROLE;
UPDATE work.outbox SET available_at = now() WHERE event_id = '00000000-0000-0000-0000-0000000000e1';
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = '';
SELECT count(*) AS reclaimed FROM work.claim_outbox('relay-a', 10, 60) \gset
SELECT work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e1', 'relay-a', 'payload_invalid', false) AS fail2 \gset
INSERT INTO smoke_assert
SELECT 'outbox_dead_letter_blocks_aggregate',
  :'reclaimed'::int = 1 AND :'fail2' = 'dead_letter'
  AND NOT EXISTS (
    SELECT 1 FROM work.claim_outbox('relay-a', 10, 60)
    WHERE event_id = '00000000-0000-0000-0000-0000000000e2');
DO $$ BEGIN
  BEGIN
    PERFORM work.mark_outbox_delivered('00000000-0000-0000-0000-0000000000e1', 'relay-a');
    RAISE EXCEPTION 'expected_outbox_dead_lettered';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'outbox_dead_lettered' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e3', 'relay-a', 'Bad Code!', true);
    RAISE EXCEPTION 'expected_invalid_request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'invalid_request' THEN RAISE; END IF;
  END;
END $$;

RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'outbox_dead_letter_audited', count(*) = 1
FROM work.audit_event
WHERE action = 'outbox.dead_lettered' AND metadata->>'error_code' = 'payload_invalid';

-- Ops: a stale start_workflow cannot be requeued; skip unblocks; a cancel_signal can be requeued.
SET LOCAL ROLE work_ops;
SET LOCAL app.subject_id = 'ops:oncall';
SET LOCAL app.org_id = 'org1';
DO $$ BEGIN
  BEGIN
    PERFORM work.requeue_outbox_dead_letter('00000000-0000-0000-0000-0000000000e1', 'ops:oncall', 'retry after fix');
    RAISE EXCEPTION 'expected_outbox_requeue_stale';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'outbox_requeue_stale' THEN RAISE; END IF;
  END;
END $$;
SELECT work.skip_outbox_dead_letter('00000000-0000-0000-0000-0000000000e1', 'ops:oncall', 'run never existed');

SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = '';
CREATE TEMP TABLE c2 AS SELECT * FROM work.claim_outbox('relay-a', 10, 60);
INSERT INTO smoke_assert
SELECT 'outbox_skip_unblocks_next', EXISTS (SELECT 1 FROM c2 WHERE event_id = '00000000-0000-0000-0000-0000000000e2');
SELECT work.mark_outbox_failed('00000000-0000-0000-0000-0000000000e2', 'relay-a', 'payload_invalid', false);

SET LOCAL ROLE work_ops;
SET LOCAL app.subject_id = 'ops:oncall';
SET LOCAL app.org_id = 'org1';
SELECT work.requeue_outbox_dead_letter('00000000-0000-0000-0000-0000000000e2', 'ops:oncall', 'payload fixed upstream');
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'outbox_requeue_and_skip_audited',
  (SELECT dead_lettered_at IS NULL AND attempts = 0 AND claimed_by IS NULL FROM work.outbox
     WHERE event_id = '00000000-0000-0000-0000-0000000000e2')
  AND (SELECT last_error_code = 'skipped_by_ops' AND delivered_at IS NOT NULL FROM work.outbox
     WHERE event_id = '00000000-0000-0000-0000-0000000000e1')
  AND EXISTS (SELECT 1 FROM work.audit_event WHERE action = 'outbox.requeued')
  AND EXISTS (SELECT 1 FROM work.audit_event WHERE action = 'outbox.skipped');
INSERT INTO smoke_assert
SELECT 'outbox_ops_not_granted_to_worker',
  NOT has_function_privilege('work_worker', 'work.requeue_outbox_dead_letter(uuid, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_api', 'work.requeue_outbox_dead_letter(uuid, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_worker', 'work.skip_outbox_dead_letter(uuid, text, text)', 'EXECUTE')
  AND NOT has_table_privilege('work_ops', 'work.outbox', 'UPDATE');

-- A dead-lettered start_workflow fails the queued run and supersedes later messages of that run.
UPDATE work.outbox SET delivered_at = now() WHERE delivered_at IS NULL;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-dl', 'sha256:input-dl', 64, 'application/json'
) AS dl_input \gset
SELECT task_id AS dl_task, run_id AS dl_run FROM work.submit_task(
  'org1', 'user1', 'req-dead-start', :'dl_input'::uuid, '派发死信', 'ask_each', 'sha256:snap-dl',
  '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-dead-start', 'pi-1.4.0'
) \gset
SELECT work.request_cancel('org1', :'dl_run'::uuid, 'user1', 'user_requested');
RESET ROLE;
SELECT event_id AS dl_start FROM work.outbox
WHERE aggregate_id = :'dl_run'::uuid AND payload->>'kind' = 'start_workflow' \gset
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = '';
SELECT count(*) AS dl_claimed FROM work.claim_outbox('relay-a', 10, 60) WHERE event_id = :'dl_start'::uuid \gset
SELECT work.mark_outbox_failed(:'dl_start'::uuid, 'relay-a', 'workflow_type_unknown', false) AS dl_result \gset
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'outbox_start_dead_letter_fails_run',
  :'dl_claimed'::int = 1 AND :'dl_result' = 'dead_letter'
  AND (SELECT state = 'canceled' OR state = 'failed' FROM work.run WHERE id = :'dl_run'::uuid)
  AND (SELECT active_run_id IS NULL FROM work.task WHERE id = :'dl_task'::uuid)
  AND NOT EXISTS (SELECT 1 FROM work.outbox WHERE aggregate_id = :'dl_run'::uuid AND delivered_at IS NULL
                  AND dead_lettered_at IS NULL);

-- ---------------------------------------------------------------------------
-- Deletion + ownership transfer (C27/C30 design closure)
-- ---------------------------------------------------------------------------
RESET ROLE;
INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
VALUES ('org1', 'user3', 'active', 'member', true),
       ('org1', 'user4', 'active', 'member', false),
       ('org1', 'user5', 'active', 'viewer', true);
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';

SELECT work.create_input(
  'org1', 'user1', 'content://org1/input-del', 'sha256:input-del', 64, 'application/json'
) AS del_input \gset
SELECT task_id AS busy_task FROM work.submit_task(
  'org1', 'user1', 'req-del-busy',
  :'del_input'::uuid, '进行中任务', 'ask_each', 'sha256:snap-del',
  '{"template":null}'::jsonb,
  ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb,
  'price-v1', 'wf-req-del-busy', 'pi-1.4.0'
) \gset

DO $$ BEGIN
  BEGIN
    PERFORM work.delete_task('org1', (SELECT id FROM work.task WHERE title = '进行中任务'), 'user1',
      (SELECT revision FROM work.task WHERE title = '进行中任务'), 'user_requested');
    RAISE EXCEPTION 'expected_run_not_quiescent';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'run_not_quiescent' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.subject_id', 'user3', true);
  BEGIN
    PERFORM work.delete_task('org1', (SELECT id FROM work.task WHERE title = '季度复盘'), 'user3',
      (SELECT revision FROM work.task WHERE title = '季度复盘'), 'user_requested');
    RAISE EXCEPTION 'expected_task_not_found';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.subject_id', 'user1', true);
  BEGIN
    PERFORM work.delete_task('org1', (SELECT id FROM work.task WHERE title = '季度复盘'), 'user1', 0, 'user_requested');
    RAISE EXCEPTION 'expected_version_conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'version_conflict' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'delete_requires_quiescent_owner', true;

SELECT revision AS del_rev FROM work.task WHERE id = :'task_id'::uuid \gset
SELECT work.delete_task('org1', :'task_id'::uuid, 'user1', :'del_rev'::bigint, 'user_requested') AS shred_refs \gset
SELECT work.delete_task('org1', :'task_id'::uuid, 'user1', :'del_rev'::bigint, 'user_requested') AS shred_refs_again \gset
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
SET LOCAL app.subject_id = 'ops:oncall';
SET LOCAL app.org_id = 'org1';
DO $$ BEGIN
  BEGIN
    PERFORM work.transfer_task_ownership('org1', (SELECT xfer_id FROM ops_ids), 'user4', 'ops:oncall', 'SUP-101', 'owner left');
    RAISE EXCEPTION 'expected_work_seat_required';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'work_seat_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.transfer_task_ownership('org1', (SELECT xfer_id FROM ops_ids), 'user5', 'ops:oncall', 'SUP-104', 'owner left');
    RAISE EXCEPTION 'expected_work_seat_required_viewer';
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
  AND NOT has_function_privilege('work_api', 'work.delete_task_core(text, uuid, text, text, bigint, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_ops', 'work.delete_task_core(text, uuid, text, text, bigint, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_ops', 'work.submit_task(text, text, text, uuid, text, text, text, jsonb, text[], jsonb, text, text, text)', 'EXECUTE');

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
-- Review fixes: input isolation on delete, deleted tasks are inert, replay before
-- admission, user artifact versions, session-subject binding
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';

-- Same content twice: the bound input is not reused; both inputs share one content_ref.
SELECT work.create_input('org1', 'user1', 'content://org1/shared', 'sha256:shared', 64, 'application/json') AS shared_a \gset
SELECT task_id AS shared_task_a, run_id AS shared_run_a FROM work.submit_task(
  'org1', 'user1', 'req-shared-a', :'shared_a'::uuid, '共享A', 'ask_each', 'sha256:snap-sa',
  '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-shared-a', 'pi-1.4.0'
) \gset
SELECT work.create_input('org1', 'user1', 'content://org1/shared', 'sha256:shared', 64, 'application/json') AS shared_b \gset
SELECT task_id AS shared_task_b, run_id AS shared_run_b FROM work.submit_task(
  'org1', 'user1', 'req-shared-b', :'shared_b'::uuid, '共享B', 'ask_each', 'sha256:snap-sb',
  '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-shared-b', 'pi-1.4.0'
) \gset
INSERT INTO smoke_assert SELECT 'input_bound_not_reused', :'shared_a'::uuid <> :'shared_b'::uuid;
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM work.submit_task(
      'org1', 'user1', 'req-shared-c', (SELECT input_id FROM work.task WHERE title = '共享A'),
      '共享C', 'ask_each', 'sha256:snap-sc', '{}'::jsonb, ARRAY['model_call']::text[],
      '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-shared-c', 'pi-1.4.0');
    RAISE EXCEPTION 'expected_input_not_found';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'input_not_found' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'bound_input_not_resubmittable', true;

-- Replay is answered before admission checks: a suspended org still replays, new submits are refused.
RESET ROLE;
UPDATE work.org SET operator_suspended = true WHERE id = 'org1';
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT task_id AS shared_b_replay FROM work.submit_task(
  'org1', 'user1', 'req-shared-b', :'shared_b'::uuid, '共享B', 'ask_each', 'sha256:snap-sb',
  '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-shared-b', 'pi-1.4.0'
) \gset
DO $$ BEGIN
  BEGIN
    PERFORM work.create_input('org1', 'user1', 'content://org1/new', 'sha256:new', 8, 'application/json');
    PERFORM 1 FROM work.submit_task(
      'org1', 'user1', 'req-suspended', (SELECT id FROM work.input_object WHERE content_hash = 'sha256:new'),
      '暂停中', 'ask_each', 'sha256:snap-x', '{}'::jsonb, ARRAY['model_call']::text[],
      '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-suspended', 'pi-1.4.0');
    RAISE EXCEPTION 'expected_org_execution_unavailable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'org_execution_unavailable' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'submit_replay_before_admission', :'shared_b_replay'::uuid = :'shared_task_b'::uuid;
RESET ROLE;
UPDATE work.org SET operator_suspended = false WHERE id = 'org1';

-- Make A quiescent (run failed), then delete A: B keeps its input and the shared object is not shredded.
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT work.finish_run(:'shared_run_a'::uuid, 'org1', 'failed', 'provider_error');
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT revision AS shared_a_rev FROM work.task WHERE id = :'shared_task_a'::uuid \gset
SELECT work.delete_task('org1', :'shared_task_a'::uuid, 'user1', :'shared_a_rev'::bigint, 'user_requested') AS shared_a_refs \gset
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'delete_keeps_other_task_input',
  (SELECT status = 'active' AND deleted_at IS NULL FROM work.input_object WHERE id = :'shared_b'::uuid)
  AND (SELECT status = 'deleted' FROM work.input_object WHERE id = :'shared_a'::uuid)
  AND NOT EXISTS (
    SELECT 1 FROM work.outbox
    WHERE aggregate_type = 'content' AND aggregate_id = :'shared_task_a'::uuid
      AND payload->'content_refs' ? 'content://org1/shared');

-- Deleted tasks are inert: no retry/accept/title/version, hidden from summary, submit replay says task_deleted.
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
DO $$
DECLARE tid uuid := (SELECT id FROM work.task WHERE deleted_at IS NOT NULL AND input_id = (
  SELECT id FROM work.input_object WHERE content_hash = 'sha256:shared' AND status = 'deleted'));
BEGIN
  BEGIN
    PERFORM work.retry_task('org1', tid, 'user1', 'req-retry-del1', (SELECT revision FROM work.task WHERE id = tid),
      'wf-del-retry', 'pi-1.4.0');
    RAISE EXCEPTION 'expected_task_not_found_retry';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.accept_task('org1', tid, 'user1', 'req-accept-del1', (SELECT revision FROM work.task WHERE id = tid),
      NULL, NULL, 'done');
    RAISE EXCEPTION 'expected_task_not_found_accept';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.update_task_title('org1', tid, 'user1', 'req-title-del1', (SELECT revision FROM work.task WHERE id = tid), 'x');
    RAISE EXCEPTION 'expected_task_not_found_title';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_not_found' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM 1 FROM work.submit_task(
      'org1', 'user1', 'req-shared-a', (SELECT input_id FROM work.task WHERE id = tid), '共享A', 'ask_each',
      'sha256:snap-sa', '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb,
      'price-v1', 'wf-shared-a', 'pi-1.4.0');
    RAISE EXCEPTION 'expected_task_deleted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'task_deleted' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert
SELECT 'deleted_task_inert', NOT EXISTS (SELECT 1 FROM work.task_summary WHERE task_id = :'shared_task_a'::uuid);

-- User edits an artifact: new immutable version on top of the latest, conflicts on stale base,
-- bumps task revision (stale accept fails), read-only once completed.
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT fence AS fence_b FROM work.acquire_run(:'shared_run_b'::uuid, 'org1') \gset
SELECT artifact_id AS art_b FROM work.publish_artifact(
  'org1', :'shared_task_b'::uuid, :'shared_run_b'::uuid, 'draft.md', 'content://org1/b-v1',
  'sha256:b-v1', 32, 'text/markdown', '{}'::jsonb
) \gset
SELECT work.finish_run(:'shared_run_b'::uuid, 'org1', 'succeeded', NULL);
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT revision AS b_rev_before FROM work.task WHERE id = :'shared_task_b'::uuid \gset
SELECT version_no AS b_v2, task_revision AS b_rev_after FROM work.create_user_artifact_version(
  'org1', :'art_b'::uuid, 'user1', 'req-version-0001', 1, 'content://org1/b-v2', 'sha256:b-v2', 40, 'text/markdown'
) \gset
SELECT version_no AS b_v2_replay FROM work.create_user_artifact_version(
  'org1', :'art_b'::uuid, 'user1', 'req-version-0001', 1, 'content://org1/b-v2', 'sha256:b-v2', 40, 'text/markdown'
) \gset
DO $$
DECLARE aid uuid := (SELECT a.id FROM work.artifact a JOIN work.task t ON t.id = a.task_id WHERE t.title = '共享B');
BEGIN
  BEGIN
    PERFORM work.create_user_artifact_version('org1', aid, 'user1', 'req-version-0002', 1,
      'content://org1/b-v3', 'sha256:b-v3', 40, 'text/markdown');
    RAISE EXCEPTION 'expected_version_conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'version_conflict' THEN RAISE; END IF;
  END;
END $$;
DO $$
DECLARE tid uuid := (SELECT id FROM work.task WHERE title = '共享B');
BEGIN
  BEGIN
    PERFORM work.accept_task('org1', tid, 'user1', 'req-accept-b0', (SELECT revision FROM work.task WHERE id = tid) - 1,
      (SELECT id FROM work.artifact WHERE task_id = tid), 1, NULL);
    RAISE EXCEPTION 'expected_version_conflict_after_edit';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'version_conflict' THEN RAISE; END IF;
  END;
END $$;
SELECT acceptance_id AS acc_b FROM work.accept_task(
  'org1', :'shared_task_b'::uuid, 'user1', 'req-accept-b1', :'b_rev_after'::bigint, :'art_b'::uuid, 2, NULL
) \gset
DO $$
DECLARE aid uuid := (SELECT a.id FROM work.artifact a JOIN work.task t ON t.id = a.task_id WHERE t.title = '共享B');
BEGIN
  BEGIN
    PERFORM work.create_user_artifact_version('org1', aid, 'user1', 'req-version-0003', 2,
      'content://org1/b-v3', 'sha256:b-v3', 40, 'text/markdown');
    RAISE EXCEPTION 'expected_artifact_read_only';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'artifact_read_only' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SET LOCAL app.org_id = 'org1';
INSERT INTO smoke_assert
SELECT 'user_artifact_version',
  :'b_v2'::int = 2 AND :'b_v2_replay'::int = 2
  AND :'b_rev_after'::bigint = :'b_rev_before'::bigint + 1
  AND (SELECT provenance->>'source' = 'user' FROM work.artifact_version
       WHERE artifact_id = :'art_b'::uuid AND version_no = 2)
  AND (SELECT version_no = 2 FROM work.acceptance WHERE id = :'acc_b'::uuid);

-- A canceled latest run freezes the artifact, matching the run_canceled read-only UI.
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT work.create_input('org1', 'user1', 'content://org1/ro', 'sha256:ro', 8, 'application/json') AS ro_input \gset
SELECT task_id AS ro_task, run_id AS ro_run FROM work.submit_task(
  'org1', 'user1', 'req-ro-1', :'ro_input'::uuid, '取消后只读', 'ask_each', 'sha256:snap-ro',
  '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-ro-1', 'pi-1.4.0'
) \gset
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT fence AS ro_fence FROM work.acquire_run(:'ro_run'::uuid, 'org1') \gset
SELECT artifact_id AS ro_art FROM work.publish_artifact(
  'org1', :'ro_task'::uuid, :'ro_run'::uuid, 'draft.md', 'content://org1/ro-v1',
  'sha256:ro-v1', 8, 'text/markdown', '{}'::jsonb
) \gset
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT work.request_cancel('org1', :'ro_run'::uuid, 'user1', 'user_requested');
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT work.finish_run(:'ro_run'::uuid, 'org1', 'canceled', 'user_requested');
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
DO $$
DECLARE aid uuid := (SELECT a.id FROM work.artifact a JOIN work.task t ON t.id = a.task_id WHERE t.title = '取消后只读');
BEGIN
  BEGIN
    PERFORM work.create_user_artifact_version('org1', aid, 'user1', 'req-ro-version', 1,
      'content://org1/ro-v2', 'sha256:ro-v2', 8, 'text/markdown');
    RAISE EXCEPTION 'expected_artifact_read_only_after_cancel';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'artifact_read_only' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SET LOCAL app.org_id = 'org1';

-- No session subject → every API command refuses.
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = '';
SET LOCAL app.org_id = 'org1';
DO $$ BEGIN
  BEGIN
    PERFORM work.create_input('org1', 'user1', 'content://org1/x', 'sha256:x', 8, 'application/json');
    RAISE EXCEPTION 'expected_actor_mismatch';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'actor_mismatch' THEN RAISE; END IF;
  END;
END $$;
INSERT INTO smoke_assert SELECT 'session_subject_required', true;
INSERT INTO smoke_assert
SELECT 'api_grants_scoped',
  NOT has_function_privilege('work_api', 'work.publish_artifact(text, uuid, uuid, text, text, text, bigint, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('work_api', 'work.cancel_operation(text, uuid, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('work_api', 'work.request_approval(text, uuid, text, jsonb, text, timestamptz, bigint)', 'EXECUTE')
  AND has_function_privilege('work_api', 'work.retry_task(text, uuid, text, text, bigint, text, text)', 'EXECUTE');
RESET ROLE;

-- Orchestration guards: cancel before start, no success over a cancel request, reason codes on unknown.
SET LOCAL ROLE work_api;
SET LOCAL app.subject_id = 'user1';
SET LOCAL app.org_id = 'org1';
SELECT work.create_input('org1', 'user1', 'content://org1/orch', 'sha256:orch', 8, 'application/json') AS orch_input \gset
SELECT run_id AS orch_run FROM work.submit_task(
  'org1', 'user1', 'req-orch-1', :'orch_input'::uuid, '编排守卫', 'ask_each', 'sha256:snap-orch',
  '{}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb, 'price-v1', 'wf-orch-1', 'pi-1.4.0'
) \gset
SELECT work.request_cancel('org1', :'orch_run'::uuid, 'user1', 'user_requested');
RESET ROLE;
SET LOCAL ROLE work_worker;
SET LOCAL app.org_id = 'org1';
SELECT state AS orch_acq_state, fence AS orch_acq_fence FROM work.acquire_run(:'orch_run'::uuid, 'org1') \gset
DO $$ BEGIN
  BEGIN
    PERFORM work.finish_run((SELECT active_run_id FROM work.task WHERE title = '编排守卫'), 'org1', 'succeeded', NULL);
    RAISE EXCEPTION 'expected_run_cancel_requested';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'run_cancel_requested' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM work.mark_operation_unknown('org1', (SELECT id FROM work.operation WHERE org_id = 'org1' LIMIT 1), 'Provider Unknown!');
    RAISE EXCEPTION 'expected_invalid_reason_code';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'invalid_reason_code' THEN RAISE; END IF;
  END;
END $$;
SELECT work.finish_run(:'orch_run'::uuid, 'org1', 'canceled', 'user_requested');
SELECT work.finish_run(:'orch_run'::uuid, 'org1', 'canceled', 'user_requested');
INSERT INTO smoke_assert
SELECT 'acquire_cancel_requested_no_fence',
  :'orch_acq_state' = 'cancel_requested' AND :'orch_acq_fence'::bigint = 1
  AND (SELECT state = 'canceled' AND terminal_reason = 'user_requested'
       FROM work.run WHERE id = :'orch_run'::uuid);
INSERT INTO smoke_assert SELECT 'no_success_over_cancel_request', true;
INSERT INTO smoke_assert SELECT 'unknown_reason_code_enforced', true;
RESET ROLE;

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
