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
| `r0a-schema-smoke.sql` | 34 项断言 + 负例；事务结束回滚 |

### D2 契约资产

| 文件 | 用途 |
|---|---|
| `r0a-openapi-v1.yaml` | R0a 公开 API 子集：20 path/48 schema |
| `r0a-api-types.d.ts` | `openapi-typescript 7.13.0` 生成的 TypeScript 类型 |
| `generate-client.mjs` | 从 OpenAPI 生成运行时客户端、参数/body/响应模型与漂移检查入口 |
| `r0a-client.mjs` | 生成的零依赖 fetch 客户端：cookie/CSRF、错误映射、SSE 解析；21 个 operation |
| `admin-read-adapter.mjs` | P1-A → R0a 管理读契约的严格适配参考：缺失字段抛 gap，不伪造预算/角色/导出作业 |
| `mock-server.mjs` | 无依赖内存 mock：cookie/CSRF、输入/模板、任务/运行、SSE、成果、管理只读 |
| `scripts/ci-contract.mjs` | CI 门禁：冻结 operation、`$ref`、生成客户端/类型漂移、全部测试 |
| `test/contract.test.mjs` | 6 组合同测试：golden path + 幂等/scope/取消/SSE/权限负例 |
| `test/client.test.mjs` | 7 组生成客户端测试：golden path、SSE、401/403/404、CSRF、管理读、参数校验 |
| `test/admin-adapter.test.mjs` | 12 组管理适配测试：字段缺口、状态映射、分页、token/cents 不转换、导出生命周期 |
| `package.json` | `npm test` / `npm run check` 入口（仅 Node 内置模块，无运行时依赖） |

## D2 运行

```bash
cd docs/plan/assets/work-r0a-design-2026-10-25

# 25 组测试（合同 6 + 客户端 7 + 管理适配 12）
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

预期最后输出 34 行 `ok = t`，然后 `ROLLBACK`。

## 已验证

- D1：空库应用 schema 成功；34/34 断言通过（输入/提交幂等、scope 拒绝、直接 DML 拒绝、跨租户 RLS、派发、预算结算/修正、成果发布、采纳、审批、取消/重试、等待/恢复、unknown/reconcile、workflow-start/cancel outbox、task summary）。
- D1：所有 `work` schema 函数为 `SECURITY DEFINER`，`work_api`/`work_worker` 无事实表直接 DML；所有租户表 `ENABLE` + `FORCE ROW LEVEL SECURITY`。
- D2：OpenAPI 3.1 校验通过（20 path/48 schema/62 本地 `$ref`）；生成类型 `tsc --noEmit` 通过；合同测试 6/6、生成客户端 7/7、管理适配 12/12 通过。
- D2：`scripts/ci-contract.mjs` 通过：操作清单与 R0a 冻结集一致、170 处本地 `$ref`（62 个唯一目标）可解析、生成客户端无漂移、类型包含全部 operation/引用的 schema；25/25 测试通过。
- D2：管理适配参考证明 P1-A 原始返回不能伪装成 R0a 契约（缺 role/revision/subject/seat total、token≠cents、同步 CSV≠异步导出），缺口以错误暴露。
- CI：`.github/workflows/work-r0a-gates.yml` 已定义 contract/ops-telemetry/log-scan 三个 job；**尚未在远端运行**。

## 未验证

D1：并发多连接竞态、连接池租户上下文、生产数据量/索引、迁移回滚、真实 Content Store、Temporal、真实模型/供应商、留存删除、operator 停用、P1-A 集成、用户上传/编辑流程。
D2：真实 cookie/CSRF 签发、真实 SSE 网关/背压/多连接、真实持久化、真实鉴权、CORS、桌面/移动、性能/模糊测试、生成客户端接入真实前端、远端 CI 运行、P1-A 真实字段接入；管理适配只在 fixture 上验证，尚未接真实 P1-A/身份服务。

## 与其他文档

- 设计说明：[../../work-r0a-data-design-2026-10-25.md](../../work-r0a-data-design-2026-10-25.md)
- 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
- 完整 DDL：[../../work-data-model-ddl-draft-2026-10-25.md](../../work-data-model-ddl-draft-2026-10-25.md)
- API 契约：[../../work-api-contracts-2026-10-25.md](../../work-api-contracts-2026-10-25.md)
