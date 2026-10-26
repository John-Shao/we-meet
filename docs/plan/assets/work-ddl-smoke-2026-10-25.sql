-- Work DDL 冒烟：任务静止 / 派发 / 采纳 / active_run / 预算账目
-- 前置：同一个数据库已应用 work-ddl-draft-2026-10-25.sql。
-- 运行：psql -v ON_ERROR_STOP=1 -f work-ddl-smoke-2026-10-25.sql
-- 全部用例在事务内执行，结束回滚，不留下测试数据。

BEGIN;
SET search_path TO work, public;

INSERT INTO work.org (id, status, home_region)
VALUES ('org-ddl', 'active', 'cn-north');
INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
VALUES ('org-ddl', 'alice', 'active', 'owner', true);

INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode)
VALUES ('00000000-0000-0000-0000-000000000001', 'org-ddl', 'alice', 'open', 'ask_each');
INSERT INTO work.capability_snapshot
  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
   model_route, scope_caps, price_version, manifest)
VALUES
  ('00000000-0000-0000-0000-000000000011', 'org-ddl',
   '00000000-0000-0000-0000-000000000001', 'r1', 'snap-hash-1',
   ARRAY['read'], '{"model":"qwen"}'::jsonb, '{}'::jsonb, 'price-1', '{}'::jsonb);
UPDATE work.task SET snapshot_id = '00000000-0000-0000-0000-000000000011'
WHERE id = '00000000-0000-0000-0000-000000000001';

-- 1. 创建 Run：active/latest 同时指向新 Run
SELECT work.create_run(
  '00000000-0000-0000-0000-000000000001', 'org-ddl',
  '00000000-0000-0000-0000-000000000011', 'wf-1', 'rt-1'
) AS run1 \gset

DO $$
DECLARE t work.task%ROWTYPE;
BEGIN
  SELECT * INTO t FROM work.task WHERE id = '00000000-0000-0000-0000-000000000001';
  IF t.active_run_id::text IS DISTINCT FROM (SELECT id::text FROM work.run WHERE workflow_id = 'wf-1')
     OR t.latest_run_id::text IS DISTINCT FROM (SELECT id::text FROM work.run WHERE workflow_id = 'wf-1') THEN
    RAISE EXCEPTION 'active/latest run not set';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM work.create_run(
      '00000000-0000-0000-0000-000000000001', 'org-ddl',
      '00000000-0000-0000-0000-000000000011', 'wf-duplicate', 'rt-1'
    );
    RAISE EXCEPTION 'expected active run to block second run';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%task_has_active_run%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT work.acquire_run(
  (SELECT id FROM work.run WHERE workflow_id = 'wf-1'), 'org-ddl'
);
DO $$
BEGIN
  IF (SELECT state FROM work.run WHERE workflow_id = 'wf-1') <> 'active'
     OR (SELECT fence FROM work.run WHERE workflow_id = 'wf-1') <> 2 THEN
    RAISE EXCEPTION 'acquire_run did not activate/increment fence';
  END IF;
END;
$$;

-- 2. Operation 只能在活跃 Run 下创建；重复 key 同 hash 返回原 Operation
SELECT work.create_operation(
  (SELECT id FROM work.run WHERE workflow_id = 'wf-1'), 'org-ddl',
  'model:1', 'model', 'request-hash-1'
) AS op1 \gset

DO $$
BEGIN
  IF work.create_operation(
    (SELECT id FROM work.run WHERE workflow_id = 'wf-1'), 'org-ddl',
    'model:1', 'model', 'request-hash-1'
  ) IS DISTINCT FROM (SELECT id FROM work.operation WHERE logical_key = 'model:1') THEN
    RAISE EXCEPTION 'operation idempotency failed';
  END IF;
  BEGIN
    PERFORM work.create_operation(
      (SELECT id FROM work.run WHERE workflow_id = 'wf-1'), 'org-ddl',
      'model:1', 'model', 'different-hash'
    );
    RAISE EXCEPTION 'expected operation key conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%operation_key_conflict%' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE work.operation SET state = 'authorized' WHERE logical_key = 'model:1';

-- 3. 预算：释放后允许新的 reservation_seq；结算 revision + adjust 冲销
INSERT INTO work.budget_account
  (org_id, account_key, period_id, currency, limit_cents)
VALUES ('org-ddl', 'default', '2026-10', 'CNY', 100);

SELECT work.reserve_budget(
  'org-ddl', 'default', '2026-10',
  (SELECT id FROM work.operation WHERE logical_key = 'model:1'), 30
) AS res1 \gset

SELECT work.release_budget(:'res1');

SELECT work.reserve_budget(
  'org-ddl', 'default', '2026-10',
  (SELECT id FROM work.operation WHERE logical_key = 'model:1'), 30
) AS res2 \gset

DO $$
DECLARE r work.budget_reservation%ROWTYPE;
BEGIN
  SELECT * INTO r FROM work.budget_reservation
  WHERE id = (SELECT id FROM work.budget_reservation WHERE reservation_seq = 2 AND state = 'held');
  IF r.reservation_seq <> 2 OR r.amount_cents <> 30 THEN
    RAISE EXCEPTION 're-reserve sequencing failed';
  END IF;
END;
$$;

SELECT work.settle_budget(:'res2', 25, 'price-1', '{"tokens":10}'::jsonb, 1);
SELECT work.adjust_budget(:'res2', -5, 'discount', 2);
SELECT work.adjust_budget(:'res2', -5, 'discount', 2);

-- 同 revision 同金额幂等；同 revision 不同金额冲突
SELECT work.settle_budget(:'res2', 25, 'price-1', '{"tokens":10}'::jsonb, 1);
DO $$
BEGIN
  PERFORM work.adjust_budget(
    (SELECT id FROM work.budget_reservation WHERE reservation_seq = 2 AND state = 'settled'),
    -4, 'conflict', 2
  );
  RAISE EXCEPTION 'expected adjustment revision conflict';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%settlement_revision_not_monotonic%' THEN RAISE; END IF;
END;
$$;
DO $$
BEGIN
  PERFORM work.settle_budget(
    (SELECT id FROM work.budget_reservation WHERE reservation_seq = 2 AND state = 'settled'),
    20, 'price-1', '{}'::jsonb, 1
  );
  RAISE EXCEPTION 'expected settlement revision conflict';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%settlement_revision_not_monotonic%' THEN RAISE; END IF;
END;
$$;

DO $$
DECLARE a work.budget_account%ROWTYPE;
BEGIN
  SELECT * INTO a FROM work.budget_account WHERE org_id = 'org-ddl' AND account_key = 'default';
  IF a.reserved_cents <> 0 OR a.settled_cents <> 20 THEN
    RAISE EXCEPTION 'budget balances mismatch: reserved=%, settled=%', a.reserved_cents, a.settled_cents;
  END IF;
  IF (SELECT count(*) FROM work.budget_entry) <> 5 THEN
    RAISE EXCEPTION 'unexpected budget entry count';
  END IF;
END;
$$;

-- 4. 派发需要 Run active、Task active_run 匹配、fence 正确
DO $$
DECLARE attempt uuid;
BEGIN
  SELECT work.claim_dispatch(
    (SELECT id FROM work.operation WHERE logical_key = 'model:1'),
    'org-ddl', 'consumer-a', 2
  ) INTO attempt;
  IF attempt IS NULL THEN RAISE EXCEPTION 'expected dispatch claim'; END IF;
END;
$$;

UPDATE work.operation SET state = 'unknown' WHERE logical_key = 'model:1';

-- 5. Run 失败：清空 active、保留 latest；unknown Operation 阻止新 Run
DO $$
BEGIN
  PERFORM work.finish_run((SELECT id FROM work.run WHERE workflow_id = 'wf-1'), 'org-ddl', 'failed', 'stream lost');
END;
$$;

DO $$
DECLARE t work.task%ROWTYPE;
BEGIN
  SELECT * INTO t FROM work.task WHERE id = '00000000-0000-0000-0000-000000000001';
  IF t.active_run_id IS NOT NULL
     OR t.latest_run_id::text IS DISTINCT FROM (SELECT id::text FROM work.run WHERE workflow_id = 'wf-1') THEN
    RAISE EXCEPTION 'terminal run did not update active/latest';
  END IF;
  BEGIN
    PERFORM work.create_run(
      '00000000-0000-0000-0000-000000000001', 'org-ddl',
      '00000000-0000-0000-0000-000000000011', 'wf-2', 'rt-1'
    );
    RAISE EXCEPTION 'expected unresolved operation to block successor run';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%task_has_unresolved_operation%' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE work.operation SET state = 'reconciled' WHERE logical_key = 'model:1';

-- 6. 对账后可创建后继 Run；Run 终态后可采纳
SELECT work.create_run(
  '00000000-0000-0000-0000-000000000001', 'org-ddl',
  '00000000-0000-0000-0000-000000000011', 'wf-2', 'rt-1'
) AS run2 \gset

DO $$
BEGIN
  PERFORM work.finish_run((SELECT id FROM work.run WHERE workflow_id = 'wf-2'), 'org-ddl', 'failed', 'no-op');
END;
$$;

DO $$
DECLARE rev bigint; acc uuid;
BEGIN
  SELECT revision INTO rev FROM work.task WHERE id = '00000000-0000-0000-0000-000000000001';
  SELECT work.accept_task(
    '00000000-0000-0000-0000-000000000001', 'org-ddl',
    NULL, NULL, 'alice', rev, 'no artifact'
  ) INTO acc;
  IF acc IS NULL THEN RAISE EXCEPTION 'acceptance failed'; END IF;
END;
$$;

DO $$
DECLARE t work.task%ROWTYPE;
BEGIN
  SELECT * INTO t FROM work.task WHERE id = '00000000-0000-0000-0000-000000000001';
  IF t.state <> 'completed' OR t.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'task not completed cleanly';
  END IF;
  IF (SELECT count(*) FROM work.acceptance
      WHERE task_id = '00000000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'acceptance row count mismatch';
  END IF;
END;
$$;

-- 7. authorized Operation 阻止采纳；派发在 Run 终态后返回 NULL
INSERT INTO work.task (id, org_id, owner_subject_id, state)
VALUES ('00000000-0000-0000-0000-000000000002', 'org-ddl', 'alice', 'open');
INSERT INTO work.capability_snapshot
  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
   model_route, scope_caps, price_version, manifest)
VALUES
  ('00000000-0000-0000-0000-000000000012', 'org-ddl',
   '00000000-0000-0000-0000-000000000002', 'r1', 'snap-hash-2',
   ARRAY['read'], '{"model":"qwen"}'::jsonb, '{}'::jsonb, 'price-1', '{}'::jsonb);
UPDATE work.task SET snapshot_id = '00000000-0000-0000-0000-000000000012'
WHERE id = '00000000-0000-0000-0000-000000000002';

DO $$
BEGIN
  BEGIN
    PERFORM work.create_run(
      '00000000-0000-0000-0000-000000000002', 'org-ddl',
      '00000000-0000-0000-0000-000000000011', 'wf-wrong-snapshot', 'rt-1'
    );
    RAISE EXCEPTION 'expected cross-task snapshot rejection';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%snapshot_not_in_task%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT work.create_run(
  '00000000-0000-0000-0000-000000000002', 'org-ddl',
  '00000000-0000-0000-0000-000000000012', 'wf-3', 'rt-1'
) AS run3 \gset
SELECT work.acquire_run(
  (SELECT id FROM work.run WHERE workflow_id = 'wf-3'), 'org-ddl'
);
SELECT work.create_operation(
  (SELECT id FROM work.run WHERE workflow_id = 'wf-3'), 'org-ddl',
  'tool:1', 'tool', 'request-hash-2'
) AS op2 \gset
UPDATE work.operation SET state = 'authorized' WHERE logical_key = 'tool:1';

DO $$
BEGIN
  PERFORM work.finish_run((SELECT id FROM work.run WHERE workflow_id = 'wf-3'), 'org-ddl', 'failed', 'tool not dispatched');
END;
$$;

DO $$
DECLARE attempt uuid;
BEGIN
  SELECT work.claim_dispatch(
    (SELECT id FROM work.operation WHERE logical_key = 'tool:1'),
    'org-ddl', 'consumer-b', 2
  ) INTO attempt;
  IF attempt IS NOT NULL THEN RAISE EXCEPTION 'dispatch after terminal run should be NULL'; END IF;
END;
$$;

DO $$
DECLARE rev bigint;
BEGIN
  SELECT revision INTO rev FROM work.task WHERE id = '00000000-0000-0000-0000-000000000002';
  BEGIN
    PERFORM work.accept_task(
      '00000000-0000-0000-0000-000000000002', 'org-ddl',
      NULL, NULL, 'alice', rev, 'done'
    );
    RAISE EXCEPTION 'expected authorized operation to block acceptance';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%run_not_quiescent%' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE work.operation SET state = 'canceled' WHERE logical_key = 'tool:1';

DO $$
DECLARE rev bigint; acc uuid;
BEGIN
  SELECT revision INTO rev FROM work.task WHERE id = '00000000-0000-0000-0000-000000000002';
  SELECT work.accept_task(
    '00000000-0000-0000-0000-000000000002', 'org-ddl',
    NULL, NULL, 'alice', rev, 'done'
  ) INTO acc;
  IF acc IS NULL THEN RAISE EXCEPTION 'acceptance after cancel failed'; END IF;
END;
$$;

-- 8. 审批模式只允许 ask_each / auto_readonly / plan_then_run
DO $$
BEGIN
  BEGIN
    INSERT INTO work.task (org_id, owner_subject_id, state, permission_mode)
    VALUES ('org-ddl', 'alice', 'open', 'allow_all');
    RAISE EXCEPTION 'expected invalid permission_mode rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
