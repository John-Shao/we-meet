-- 留存清扫欠账预检（D0，授权单 §10；纯 SELECT，不含任何凭据）
--
-- 执行方式（唯一口径，RLS 与权限都按它生效；**ON_ERROR_STOP 必带**，否则 psql 报错还是 rc=0）：
--   sudo runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d work -f retention-preflight-d0.sql
-- 也就是说本体以 postgres superuser 跑，**RLS 被绕过**，所以下面每一列欠账都显式写 `org_id = '…'` 谓词，
-- 另发一组 `ALL` 前缀（不带组织过滤）的总量；`SET app.org_id` 在这个入口上不成立，不要照抄那种写法。
-- 第一行会打印本次会话到底是不是 superuser——不是的话，这些数字就变成"这个会话能看到的行"，
-- 读 0 不等于库里 0（#53 的教训），别拿它勾 D-A／D-B 分支。
-- 最后一行读 `work.schema_migration`：那张表由迁移器（`internal/migrate/ledger.go:11`）自己建，
-- 手工用裸 SQL 铺出来的库没有它，会在这里报错——现网由 `work-migrate` 铺过，所以有。
\echo '--- session identity (must say is_superuser=on for the readings below to be unfiltered) ---'
SELECT 'ctx|is_superuser=' || current_setting('is_superuser') || '|session_user=' || session_user
    || '|db=' || current_database() || '|now=' || now()::text;

\echo '--- orgs in database ---'
SELECT 'org|' || id || '|' || COALESCE(name,'-') FROM work.org ORDER BY id;

\echo '--- D0 six readings, scope=demo then scope=ALL ---'
SELECT 'demo|inputs_due|' || count(*)::text
  FROM work.input_object
 WHERE org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d'
   AND status = 'active' AND task_id IS NULL
   AND expires_at IS NOT NULL AND expires_at <= now()
UNION ALL
SELECT 'demo|exports_ready_due|' || count(*)::text
  FROM work.audit_export
 WHERE org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d'
   AND status = 'ready' AND expires_at IS NOT NULL AND expires_at <= now()
UNION ALL
SELECT 'demo|exports_expired_needing_shred|' || count(*)::text
  FROM work.audit_export e
 WHERE e.org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d'
   AND e.status = 'expired' AND e.content_ref IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.outbox o
                    WHERE o.org_id = e.org_id AND o.aggregate_type = 'content'
                      AND o.aggregate_id = e.id AND o.payload->>'kind' = 'content_shred')
UNION ALL
SELECT 'demo|shred_outbox_undelivered|' || count(*)::text
  FROM work.outbox
 WHERE org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d'
   AND aggregate_type = 'content' AND payload->>'kind' = 'content_shred'
   AND delivered_at IS NULL
UNION ALL
SELECT 'demo|inputs_due_within_25h|' || count(*)::text
  FROM work.input_object
 WHERE org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d'
   AND status = 'active' AND task_id IS NULL
   AND expires_at IS NOT NULL AND expires_at <= now() + interval '25 hours'
UNION ALL
SELECT 'demo|exports_ready_due_within_25h|' || count(*)::text
  FROM work.audit_export
 WHERE org_id = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d'
   AND status = 'ready' AND expires_at IS NOT NULL
   AND expires_at <= now() + interval '25 hours'
UNION ALL
SELECT 'ALL|inputs_due|' || count(*)::text
  FROM work.input_object
 WHERE status = 'active' AND task_id IS NULL
   AND expires_at IS NOT NULL AND expires_at <= now()
UNION ALL
SELECT 'ALL|exports_ready_due|' || count(*)::text
  FROM work.audit_export
 WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= now()
UNION ALL
SELECT 'ALL|exports_expired_needing_shred|' || count(*)::text
  FROM work.audit_export e
 WHERE e.status = 'expired' AND e.content_ref IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.outbox o
                    WHERE o.org_id = e.org_id AND o.aggregate_type = 'content'
                      AND o.aggregate_id = e.id AND o.payload->>'kind' = 'content_shred')
UNION ALL
SELECT 'ALL|shred_outbox_undelivered|' || count(*)::text
  FROM work.outbox
 WHERE aggregate_type = 'content' AND payload->>'kind' = 'content_shred'
   AND delivered_at IS NULL
UNION ALL
SELECT 'ALL|inputs_due_within_25h|' || count(*)::text
  FROM work.input_object
 WHERE status = 'active' AND task_id IS NULL
   AND expires_at IS NOT NULL AND expires_at <= now() + interval '25 hours'
UNION ALL
SELECT 'ALL|exports_ready_due_within_25h|' || count(*)::text
  FROM work.audit_export
 WHERE status = 'ready' AND expires_at IS NOT NULL
   AND expires_at <= now() + interval '25 hours'
ORDER BY 1;

\echo '--- context readings (not part of the six, but D1 needs them) ---'
SELECT 'seats|' || subject_id || '|' || role || '|work_seat=' || work_seat::text || '|' || status
  FROM work.member ORDER BY created_at;
SELECT 'status_mix|input|' || status || '|task_id_null=' || (task_id IS NULL)::text || '|' || count(*)::text
  FROM work.input_object GROUP BY status, (task_id IS NULL) ORDER BY 1;
SELECT 'status_mix|audit_export|' || status || '|' || count(*)::text
  FROM work.audit_export GROUP BY status ORDER BY 1;
SELECT 'outbox|' || aggregate_type || '|' || COALESCE(payload->>'kind','-') || '|undelivered=' ||
       count(*) FILTER (WHERE delivered_at IS NULL)::text || '|total=' || count(*)::text
  FROM work.outbox GROUP BY aggregate_type, COALESCE(payload->>'kind','-') ORDER BY 1;
SELECT 'earliest_due_input|' || COALESCE(min(expires_at)::text,'none')
  FROM work.input_object WHERE status='active' AND task_id IS NULL;
SELECT 'ledger|max_version|' || max(version)::text || '|' || max(name)
  FROM work.schema_migration;
