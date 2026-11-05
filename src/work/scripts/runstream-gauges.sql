-- R0a 运行流读数（C17 最小集，2026-11-04 主签选 C：库侧 SQL 读数，不给二进制加 Prometheus）。
--
-- 只读。不改任何账本、不发消息、不做写路径 reconcile。
-- 调用方式固定：由 scripts/run-runstream-gauges.sh 逐 org 执行，租户上下文由 wrapper 设置，
-- 因此每张 FORCE RLS 表都只返回该 org 的行（不是 §5.2 那种裸聚合，纪律见 #53）。
--
-- 为什么是这四条：2026-11-04 夜间演练（D1-alt／D2-alt）第一次拿到「在途 Run 被中断后停放」的
-- 产生过程，而 work-reconcile -scan 按定义看不见它（isOrphan() 只在 workflow 非 Running 且非
-- Unavailable 时报警；实测那批停放 Run 的 workflow 一直是 Running、pendingActivities 停在
-- STARTED、nextRetry=None，19:32 那轮巡检报 orphans=0）。所以这里补的不是「更好的告警」，
-- 而是 Prometheus 那条线在 R0a 根本不存在时**唯一能自动发现**的一条线。

-- 每个读数一行，格式固定 gauge=<name> value=<int>，供 wrapper 逐条核对（缺行＝扫描失败）。
SELECT 'ctx_org=' || set_config('app.org_id', :'org', false);

-- G1 停放 Run：开放态、超过阈值分钟没动过、且没有任何还活着的执行租约。
-- 例外：等配额（wait_reason='quota'）的 Run 是有意停放、上限 24h（#60=B，§8.3），
-- 把它算进停放会让每个饱和的组织都发一封假警报；它仍出现在下面的 open_runs 里。
SELECT 'gauge=parked_runs value=' || count(*)
  FROM work.run r
 WHERE r.state NOT IN ('succeeded', 'failed', 'canceled')
   AND NOT (r.state = 'waiting' AND COALESCE(r.wait_reason, '') = 'quota')
   AND r.updated_at < now() - make_interval(mins => :stale_minutes)
   AND NOT EXISTS (
         SELECT 1 FROM work.runtime_execution e
          WHERE e.run_id = r.id
            AND e.state = 'active'
            AND (e.lease_until IS NULL OR e.lease_until > now()));

-- G2 预留挂在已终态 Run 上没释放：§5.17 那类跨期 held，钱袋子口径。
SELECT 'gauge=held_on_terminal value=' || count(*)
  FROM work.quota_reservation q
  JOIN work.operation o ON o.id = q.operation_id AND o.org_id = q.org_id
  JOIN work.run r ON r.id = o.run_id AND r.org_id = q.org_id
 WHERE q.state = 'held'
   AND r.state IN ('succeeded', 'failed', 'canceled');

-- G3 未核账的 operation 总数（历史存量 34 条，最老约 5.4 天；只在 G2>0 时才是要动作的信号）。
SELECT 'gauge=unknown_operations value=' || count(*)
  FROM work.operation o
 WHERE o.state = 'unknown';

-- G4 停用中的组织：有意的状态，只报不警（值班必须知道现在有几个组织是被运维关着的）。
SELECT 'gauge=suspended_orgs value=' || count(*)
  FROM work.org
 WHERE execution_enabled = false OR operator_suspended = true;

-- 下面两条是上下文，不参与阈值判定。
SELECT 'gauge=open_runs value=' || count(*)
  FROM work.run
 WHERE state NOT IN ('succeeded', 'failed', 'canceled');

SELECT 'gauge=held_tokens value=' || coalesce(sum(amount_tokens - settled_tokens), 0)
  FROM work.quota_reservation
 WHERE state = 'held';
