# Work R0a 迁移 Runbook

> 适用：E1 数据层（Django 迁移 `work.0001` → `work.0002`）
>
> 权威设计：[D1 数据/权限/迁移](work-r0a-data-design-2026-10-25.md) §4、§6；[D-04](work-r0a-detailed-design-plan-2026-10-25.md)
>
> 实施步骤：[R0a 实施计划](work-r0a-implementation-plan-2026-10-27.md) E1

## 1. 迁移组成

| 迁移 | 内容 | 回滚 |
|---|---|---|
| `work.0001_create_work_roles` | 检查/创建 7 个 NOLOGIN 角色（work_owner/api/worker/ledger/migrator/ops/directory） | 不回滚角色（集群级，可能被其他库复用） |
| `work.0002_initial_r0a_schema` | 执行 `src/backend/work/sql/r0a_schema.sql`：schema、表、SECURITY DEFINER 函数、RLS、授权 | `DROP SCHEMA work CASCADE` |
| `work.0003_directory_absence` | 执行 `src/backend/work/sql/directory_absence.sql`：`directory_watermark`/`mark_members_absent`，仅授 `work_directory` | 删除这两个函数（Go runner 不提供破坏性回滚） |
| `0004_outbox_task_event_kind` | `CREATE OR REPLACE work.append_task_event`，在 outbox payload 增加 `kind=task_event`；仅替换函数，无数据变更 | 用上一版函数体重放（Go runner 不提供破坏性回滚） |
| `0005_run_workflow_id` | `CREATE OR REPLACE work.submit_task`/`work.retry_task`，workflow_id 由 DB 派生为 `run:<run_id>`；`p_workflow_id` 参数保留但忽略 | 用上一版函数体重放 |
| `0006_org_policy_quota_provision` | 默认 org policy、`ensure_quota_account`、新 org 自动 provision；新 org 默认 soft 100 万 token/月 | 删除函数/trigger；已有 policy/account 不回滚 |
| `0007_org_provision_backfill` | 对既有 org 回填 policy/quota（临时 `NO FORCE RLS` 读取 org） | 已有 policy/account 不回滚 |

`0002` 的 SQL 第一条是 `CREATE SCHEMA ... AUTHORIZATION work_owner`，随后
`GRANT ... TO work_api/work_worker/work_ledger/work_migrator/work_ops/work_directory`，
因此**必须先有 7 个角色**。迁移连接还必须是 `work_owner` 的成员（`SET ROLE`）。

## 2. 前置检查

- [ ] 已备份目标库，或确认可接受 `DROP SCHEMA work CASCADE` 的数据损失（E1 尚无业务数据）
- [ ] DBA 已执行 `deploy/aliyun/work-roles.sql`，`pg_roles` 中 7 个角色均为 NOLOGIN
- [ ] 迁移登录身份已 `GRANT work_owner TO <migration_login_role>`（D1 §6.1 身份映射）
- [ ] PostgreSQL 16，目标库允许 `CREATE SCHEMA` / `CREATE FUNCTION`
- [ ] CI 或执行机安装 `psql`（冒烟脚本使用 `\gset`）

```sql
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'work\_%' ORDER BY 1;
SELECT pg_has_role(current_user, 'work_owner', 'MEMBER');
```

## 3. 正向迁移

```bash
cd src/backend
python manage.py migrate work
python manage.py showmigrations work
```

期望：`0001_create_work_roles`、`0002_initial_r0a_schema` 与 `0003_directory_absence` 均为 `[X]`。

迁移后验证（同一库）：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
  ../../docs/plan/assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql
```

期望：退出码 0，148 行断言均为 `t`。竞态脚本使用独立一次性数据库：

```bash
createdb work_r0a_race
R0A_DATABASE_URL=postgresql://.../work_r0a_race \
R0A_SCHEMA_SQL=src/backend/work/sql/r0a_schema.sql \
R0A_LOG_FILE=/tmp/work-race.json \
python docs/plan/assets/work-r0a-design-2026-10-25/r0a-concurrency-smoke.py
```

期望：`gate.violations` 为空，9 项检查全部为 `true`。

### 3.1 Go 迁移运行器（新 ECS 生产路径）

新 ECS 的 Work schema 由 `src/work/cmd/work-migrate` 管理，不依赖 Django：

```bash
cd src/work
go run ./cmd/work-migrate status -url "$WORK_DATABASE_URL"
go run ./cmd/work-migrate apply  -url "$WORK_DATABASE_URL"
```

期望：`status` 在 apply 前显示最新 increment pending；当前最新为 `0007_org_provision_backfill`。
apply 后台账 **7 行**（0001 precondition、0002 baseline、0003–0007 increment），并校验
`catalogs/0006_org_policy_quota_provision.json`。
2026-10-28 新 ECS 已 apply 0003；2026-10-29 已 apply 0004–0007：`status=up_to_date`、台账 7 行、
catalog checkpoint 校验通过；0004/0005 仅替换函数，0006/0007 增加默认 policy/quota 与既有 org 回填。部署目录同步前仍要先跑一次 `WORK_DIRECTORY_MODE=full`
初始化水位。Go runner 不执行破坏性回滚；回滚只在
一次性库用 Django `migrate work zero` 验证。

## 4. 回滚

```bash
cd src/backend
python manage.py migrate work zero
```

结果：`work` schema 及其全部对象被删除；**7 个角色保留**。再次执行
`python manage.py migrate work` 可重建。

数据回滚：`DROP SCHEMA` 不保留业务数据。若需保留，必须在回滚前导出
`work` schema，或从备份/PITR 恢复；不得对生产库直接执行回滚演练。

回滚后检查：

```sql
SELECT to_regclass('work.task');                    -- NULL
SELECT count(*) FROM pg_roles WHERE rolname LIKE 'work\_%';  -- 7
```

## 5. 故障排查

| 现象 | 原因 | 处置 |
|---|---|---|
| `Work roles missing (...)` | 角色未预建，且迁移身份无 CREATEROLE | DBA 执行 `deploy/aliyun/work-roles.sql`；本地执行 `sql/r0a_roles.sql` |
| `migration user ... cannot SET ROLE work_owner` | 迁移身份不是 work_owner 成员 | 本地/Work DB：`GRANT work_owner TO <migration_login_role>` 后重跑；meet 生产已禁用 Work 迁移；在 Work 库执行，见 §7 |
| `permission denied to create role` | 迁移身份无 CREATEROLE 且角色缺失 | 同第一行；生产禁止给应用身份 CREATEROLE |
| `schema "work" already exists` 或对象冲突 | 手工建过 schema 或迁移状态被清理 | 确认无业务数据后 `DROP SCHEMA work CASCADE`，再重跑；不要手工改 `django_migrations` |
| 冒烟脚本 `\gset: command not found` | 用 psycopg 而非 psql 执行 | 用 `psql -f`；测试中设置 `WORK_PSQL` |
| CI `psql: command not found` | runner 未安装客户端 | backend job 已安装 `postgresql-client`；本地装客户端或用 `WORK_PSQL` |
| 回滚后再迁移报角色已存在 | 正常：角色不回滚 | 无需处理，`0001` 幂等 |

## 6. CI 与合并闸门

- `.github/workflows/work-r0a-gates.yml` 的 `backend-migration` job：服务容器 PostgreSQL 16 → 应用角色脚本 → `migrate work` → 148 冒烟 → 9 竞态 → 回滚/重放 → Work pytest。
- 该 job 与既有 `db-smoke`（设计资产源）互不替代：前者证明迁移路径，后者证明设计资产。
- 在仓库分支保护中把 `E1 migration, smoke, races and rollback` 设为 required check；本文件不修改仓库设置。
- Work 测试在 core `test-back` 中被忽略（`src/backend/work/tests`），由上述 job 执行；`work` 迁移仍随 core 测试库一起建表。

## 7. 数据库边界（2026-10-28）

Work 使用独立数据库：Work ECS 的 `work` 库，由 `work-migrate`（Go）管理；§1–§5 只适用于该库、CI 一次性库或本地库。

meet 生产库只保留 Host 侧数据（`core.organization.home_region/directory_revision`、`membership.work_seat/directory_revision` 与目录触发器），**不创建、不迁移 `work` schema**：

- `Production.MIGRATION_MODULES = {"work": None}`，生产 `manage.py migrate` 跳过 work app；CI/Test 仍运行 work 迁移以校验 SQL 资产。
- 2026-10-28 已清理 meet 库中空的 `work` schema、3 条 work 迁移台账（0001–0003）、7 个未使用 Work 角色，以及 `meet_migrator` 与 Secret `meet-migrator-db`。
- 禁止在 meet 库重新启用 Work 迁移或手工创建 `work` schema；Work schema 的增量与回滚只在 Work ECS `work` 库执行。

> 2026-10-28：meet 库旧 `public.work_*` 表（12 张）与 `django_migrations` 中 `app='work'` 记录已删除；`/work/v1` 后端路由已移除。

## 8. 旧库接管演练（2026-10-29）

用 jd-sjy 清理备份中的 `work_staging.dump` 在 Work ECS 临时库演练，不接触生产 `work` 库：

- 旧库：28 张 `work` 表、84 个函数、`django_migrations` 中 `work` 0001/0002 两行；业务表为 0 行。
- 第一次 `status` 因 `work_owner` 无 `public.django_migrations` SELECT 返回 `legacy_ledger_invalid`；补
  `GRANT SELECT ON public.django_migrations TO work_owner` 后变为 `existing_unmanaged`、pending `[3]`。
- 第一次 `apply` 返回 `drift`：`audit_export`、`provider_access_config`、`provider_credential`、`usage_daily`
  四张表缺少 `work_owner` 的 7 项表权限。补 `GRANT ALL PRIVILEGES ON TABLE ... TO work_owner` 后，
  runner 采用 0001/0002 并应用 0003，终态 `up_to_date`：3 行台账、29 张表、86 个函数。
- **不能**用 `pg_restore --no-owner` 做接管演练：它把 `work` schema 属主改成执行用户，会触发
  `permission denied for schema work`，不能代表旧库真实属主。恢复时需保留 `work_owner` 属主；缺少的
  `meet` 角色可临时创建 NOLOGIN 角色，演练后连同临时库删除。
- 真实旧库接管前，先在目标库补齐台账 SELECT 和所有 `work_owner` 表权限，再执行
  `work-migrate apply -legacy-migrator-disabled`；不要手工改 `django_migrations` 或 `work.schema_migration`。
- 证据边界：本次旧库为空数据 staging 备份，未验证旧应用流量切换、回滚或数据量性能；临时库、临时
  `meet` 角色、明文 dump 与临时二进制均已清理。

## 9. 0003 换行差异与台账兼容（2026-10-29）

2026-10-29 用新 `work-migrate` 对生产 `work` 库执行 `status`，发现历史资产差异：

- 生产台账 `work.schema_migration` 的 0003 校验和为
  `sha256:87ea354b…6b0636`，当前 manifest 为 `sha256:5207ab40…9d9c47`；
  台账 0003 于 2026-10-28 15:25 应用，早于仓库把 0003/catalog 归一为 LF 的重钉提交。
- 生产两个 0003 函数（`directory_watermark`、`mark_members_absent`）的 `prosrc` 含 CRLF；
  当前 catalog 是 LF，故新 runner 既拒绝旧台账校验和，也会报 catalog 漂移。
- 处置：先 `pg_dump -Fc` 备份到
  `/root/work-backups/work-pre-0003-lf-20261029T131630.dump`，再以当前 LF 的
  `0003_directory_absence.sql` 在 `work` 库重放（`CREATE OR REPLACE FUNCTION`，无数据变更）。
  台账保持 `87ea…` 作为“当时实际应用”的审计事实；manifest 新增
  `legacy_checksums: ["sha256:87ea…"]`，runner 只对该已声明值做兼容，当前文件仍必须匹配
  `5207…`，catalog 仍按当前 LF 快照严格比对。
- 验证：`work-migrate status` 返回 `up_to_date`；3 行台账；86 个函数；两个函数 `prosrc`
  的 CR 位置均为 0。新 migrator 已部署到 `/home/johnshao/work-migrate`，旧二进制备份
  `/home/johnshao/work-migrate.bak-20261029`。
- 证据边界：本次只改函数文本换行，无表/数据/权限变化；未做整库恢复演练。若将来再次修改已发布
  迁移正文，必须新增版本并重新签收，不能扩大 `legacy_checksums` 掩盖语义变化。
