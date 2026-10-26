# Work R0a 详细设计资产（D1）

本目录是 R0a 数据/权限/迁移的**可执行草案**，不是生产迁移，也不是对完整 Work DDL 的替代。

## 文件

| 文件 | 用途 |
|---|---|
| `generate-schema.py` | 从 [完整 DDL 草案](../work-ddl-draft-2026-10-25.sql) 裁剪 R0a 表/函数，并拼装本目录的新增对象 |
| `r0a-extra.sql` | `input_object`、Task `title/input_id` 与 FK |
| `r0a-new-functions.sql` | 输入、提交、Operation 授权/完成/取消、等待/恢复、unknown/reconcile、审批、成果、Outbox、组织执行触发器、`task_summary` |
| `r0a-rls-grants.sql` | FORCE RLS、函数所有权、`SECURITY DEFINER`、最小权限授权 |
| `r0a-schema-draft.sql` | 生成的完整 R0a schema（唯一执行入口） |
| `r0a-schema-smoke.sql` | 82 项断言 + 负例；事务结束回滚 |
| `error-codes.json` | 冻结错误码目录 `r0a-errors-v2`（42 公开码）+ 87 个 SQL 异常映射；CI 直接扫描 `r0a-schema-draft.sql` 校验 |

### D2 契约资产

| 文件 | 用途 |
|---|---|
| `r0a-openapi-v1.yaml` | R0a 公开 API 子集：20 path/23 operation/50 schema |
| `r0a-api-types.d.ts` | `openapi-typescript 7.13.0` 生成的 TypeScript 类型 |
| `generate-client.mjs` | 从 OpenAPI 生成运行时客户端、参数/body/响应模型与漂移检查入口 |
| `r0a-client.mjs` | 生成的零依赖 fetch 客户端：cookie/CSRF、错误映射、SSE 解析、403 `csrf_invalid` 单次刷新重试；23 个 operation |
| `admin-read-adapter.mjs` | P1-A → R0a 管理读契约的严格适配参考：缺失字段抛 gap，不伪造预算/角色/导出作业 |
| `mock-server.mjs` | 无依赖内存 mock：cookie/CSRF、输入/模板、任务/运行、SSE、成果、管理只读 |
| `scripts/ci-contract.mjs` | CI 门禁：冻结 operation、`$ref`、生成客户端/类型漂移、全部测试 |
| `test/contract.test.mjs` | 7 组合同测试：golden path + 幂等/scope/取消/SSE/权限负例 + 成果只读（完成后/最近 Run 取消后） |
| `test/client.test.mjs` | 12 组生成客户端测试：golden path、SSE、401/403/404、CSRF、管理读、参数校验、重试/删除的 revision 与幂等重放、code point 标题 |
| `test/admin-adapter.test.mjs` | 12 组管理适配测试：字段缺口、状态映射、分页、token/cents 不转换、导出生命周期 |
| `package.json` | `npm test` / `npm run check` 入口（仅 Node 内置模块，无运行时依赖） |

## D2 运行

```bash
cd docs/plan/assets/work-r0a-design-2026-10-25

# 31 组测试（合同 7 + 客户端 12 + 管理适配 12）
npm test

# CI 门禁：冻结 operation、$ref、客户端/类型漂移、全部测试
npm run check

# OpenAPI 变更后重新生成运行时客户端
node generate-client.mjs

# 重新生成类型（OpenAPI 变更后）
npx --yes openapi-typescript@7 r0a-openapi-v1.yaml -o r0a-api-types.d.ts
npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --moduleResolution bundler --module ESNext r0a-api-types.d.ts
```

## 前置

- PostgreSQL 16。
- 一次性数据库；脚本会 `DROP SCHEMA work` 与相关角色。
- 不要在生产库或共享开发库执行。

## 运行

```bash
docker run -d --name work-r0a-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=work_r0a \
  -p 55433:5432 postgres:16

docker exec -i work-r0a-pg psql -U postgres -d work_r0a \
  -v ON_ERROR_STOP=1 -f - < r0a-schema-draft.sql

docker exec -i work-r0a-pg psql -U postgres -d work_r0a \
  -v ON_ERROR_STOP=1 -f - < r0a-schema-smoke.sql
```

预期最后输出 82 行 `ok = t`，然后 `ROLLBACK`。

## 已验证

- D1（2026-10-26 修订）：空库应用 schema 成功；82/82 断言通过。修订新增：会话主体绑定（`app.subject_id`）、原因码枚举化、输入一次性绑定与共享引用不粉碎、删除/取消/转移的 owner+删除态校验、账本角色只读、worker 活动重放幂等（acquire/claim/reserve/finish/publish）、outbox 租约与跨组织 relay 策略、死信阻塞同聚合与 start 死信收尾 Run、运维重放/跳过审计、用户成果版本命令、启动前取消不 bump fence、cancel_requested 不得以成功收尾、unknown 原因码校验、成果编辑状态门槛（完成后或最近 Run 失败/取消只读）。原有覆盖：outbox 单聚合有序/退避/死信/重放审计、删除与粉碎 outbox、所有权转移、ops 权限、生命周期事件、标题编辑幂等/冲突/越权/事件无正文、导出审计、输入/提交幂等、scope 拒绝、直接 DML 拒绝、跨租户 RLS、派发、预算结算/修正、成果发布、采纳、审批、取消/重试、等待/恢复、unknown/reconcile、workflow-start/cancel outbox、task summary）。
- D1：所有 `work` schema 函数为 `SECURITY DEFINER`，`work_api`/`work_worker` 无事实表直接 DML；所有租户表 `ENABLE` + `FORCE ROW LEVEL SECURITY`。
- D2：OpenAPI 3.1 校验通过（20 path/23 operation/50 schema/65 唯一本地 `$ref`）；生成类型 `tsc --noEmit` 通过；合同测试 7/7、生成客户端 12/12、管理适配 12/12 通过。
- D2：`scripts/ci-contract.mjs` 通过：操作清单与 R0a 冻结集一致、187 处本地 `$ref`（65 个唯一目标）可解析、生成客户端无漂移、类型包含全部 operation/引用的 schema、错误码目录与 mock（33 码）及 `r0a-schema-draft.sql`（87 码）双向一致、无自由文本 RAISE、`retryable` 仅 5xx/429；31/31 测试通过。
- D2：管理适配参考证明 P1-A 原始返回不能伪装成 R0a 契约（缺 role/revision/subject/seat total、token≠cents、同步 CSV≠异步导出），缺口以错误暴露。
- CI：`.github/workflows/work-r0a-gates.yml` 已定义 contract（含 schema 再生成无漂移）、db-smoke（PG16 schema + 冒烟）、ops-telemetry、runtime-frontend、log-scan 五个 job；**尚未在远端运行**。

## 未验证

D1：并发多连接竞态、连接池租户上下文、生产数据量/索引、迁移回滚、真实 Content Store、Temporal、真实模型/供应商、留存删除、operator 停用、P1-A 集成、用户上传/编辑流程。
D2：真实 cookie/CSRF 签发、真实 SSE 网关/背压/多连接、真实持久化、真实鉴权、CORS、桌面/移动、性能/模糊测试、生成客户端接入真实前端、远端 CI 运行、P1-A 真实字段接入；管理适配只在 fixture 上验证，尚未接真实 P1-A/身份服务。

## 与其他文档

- 设计说明：[../../work-r0a-data-design-2026-10-25.md](../../work-r0a-data-design-2026-10-25.md)
- 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
- 完整 DDL：[../../work-data-model-ddl-draft-2026-10-25.md](../../work-data-model-ddl-draft-2026-10-25.md)
- API 契约：[../../work-api-contracts-2026-10-25.md](../../work-api-contracts-2026-10-25.md)
