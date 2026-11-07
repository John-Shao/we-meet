-- R0a 留存清扫执行体（D4 裁定＝B：systemd timer 每小时；主签 2026-11-05）。
--
-- 这不是只读巡检：三个函数都会真改状态，并由 outbox 让 work-relay 真删 Content Store 里的对象。
-- 口径全部取自现网第一次真跑（2026-11-05 16:19，逐条读数见
-- docs/plan/work-r0a-pilot-write-authorization-2026-11-05.md §11 与
-- drill-2026-11-15/attachments/d4-6b-retention-sweep-20261105.txt）：
--   · 时钟用默认 `now()`，**不提前钟**。提前钟是留给测试与回填的缝；自动化里带着它，
--     等于每小时把"未来 24 小时内将到期的未绑定输入"一起判死——那正是 §10 D2 明令禁止的一条。
--   · export 侧两条调用同事务：任一失败整体回滚，不留"已 expired 但没投 shred"的半态。
--   · input 侧独立事务。三个函数都只按 `expires_at <= p_now` **整批**取、没有按 id 入参，
--     所以"每次恰好处理 1 行"不是本体的性质，脚本不得按行数判定成功。
--   · 每张 FORCE RLS 表靠 `app.org_id` 收窄（#53 纪律：裸聚合会把"看不到的行"读成 0）。
-- 每行输出格式固定 `gauge=<name> value=<int>`，wrapper 要求四行齐全——缺行按失败处理，
-- 避免"空输出＝没问题"这种假绿（runstream-gauges.sql 同一手法）。
SELECT 'ctx_org=' || set_config('app.org_id', :'org', false);

BEGIN;
  -- 到期的审计导出正文：ready 且 expires_at<=now() ⇒ expired，并把 expires_at 置 NULL、
  -- 保留 content_ref（baseline/0002:3813 那条双向 CHECK 唯一允许的形状），随后为每条
  -- 还没投过 shred 的作业插一行 content_shred 并清空引用（作业行与元数据保留）。
  SELECT 'gauge=exports_expired value=' || work.expire_due_audit_exports()::text;
  SELECT 'gauge=exports_shredded value=' || work.shred_due_audit_exports()::text;
COMMIT;

BEGIN;
  -- 到期且未绑定任务的输入：active 且 task_id IS NULL 且 expires_at<=now() ⇒ expired＋deleted_at；
  -- 内容引用被其它未删除输入或成果共享时**只过期不投删**（这条不对称有库测钉着）。
  SELECT 'gauge=inputs_expired value=' || work.expire_due_inputs()::text;
COMMIT;

-- 投递有没有**停**：本组织还有多少条 content_shred 卡着没被 relay 投出去。
-- 必须带宽限窗，否则这是一个必然误报的判据：这些 outbox 行就在刚刚那次 COMMIT 里插入，
-- 同一次运行里查"未投递"永远非零——relay 是另一个进程，秒级轮询，15 分钟足够跑完。
-- 没有宽限窗时，"清扫真的干了活"那一次反而会把单元标红、把健康状态推成 degraded（假警报），
-- 而"relay 停了一小时"这种真事故被淹没在同一片红里。阈值可由 wrapper 传 grace_minutes 覆盖。
SELECT 'gauge=shred_stuck value=' || count(*)::text
  FROM work.outbox o
 WHERE o.aggregate_type = 'content'
   AND o.payload->>'kind' = 'content_shred'
   AND o.delivered_at IS NULL
   AND o.created_at < now() - make_interval(mins => :grace_minutes);

-- 只报不删的孤儿对象前置读数（#80 = A1 第二半）。
--
-- SQL 看不见桶，所以这里只交"库里还引用着哪些对象 id"，文件侧比对在 run-retention-scan.sh 做。
-- 走 work.list_content_refs(:'org') 而不是在本文件里直接 UNION 那四张表，是因为现读的权限面：
-- has_table_privilege('work_worker', 'work.audit_export'/'work.content_reference', 'select') = false，
-- 而本脚本的连接身份就是 work_worker 且带 ON_ERROR_STOP=1 —— 裸 SELECT 会每小时抛 42501，
-- 把一个"只报不删"的读数变成留存清扫的红灯。细节与增量 0032 的头注释同源，别在这儿重述一遍形状。
SELECT 'refid=' || x FROM (SELECT work.list_content_refs(:'org') AS x) refs;
