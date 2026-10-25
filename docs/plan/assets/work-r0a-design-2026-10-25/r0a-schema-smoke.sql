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
