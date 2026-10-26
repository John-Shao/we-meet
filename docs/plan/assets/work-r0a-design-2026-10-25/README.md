# Work R0a 详细设计资产（D1）

本目录是 R0a 数据/权限/迁移的**可执行草案**，不是生产迁移，也不是对完整 Work DDL 的替代。

## 文件

| 文件 | 用途 |
|---|---|
| `generate-schema.py` | 从 [完整 DDL 草案](../work-ddl-draft-2026-10-25.sql) 裁剪 R0a 表/函数，并拼装本目录的新增对象 |
| `r0a-extra.sql` | `input_object`、Task `title/input_id` 与 FK |
| `r0a-new-functions.sql` | 输入、提交、Operation 授权/完成/取消、等待/恢复、unknown/reconcile、审批、成果、Outbox、组织执行触发器、`task_summary` |
| `r0a-admin-directory.sql` | 管理只读（U2 方案 B）与 Host 目录投影（ADR-0021）：`audit_export` 表、`sync_org_projection`/`sync_member_projection`、`admin_overview`/`list_seats`、异步导出生命周期与一次性下载令牌 |
| `r0a-rls-grants.sql` | FORCE RLS、函数所有权、`SECURITY DEFINER`、最小权限授权（含 `work_directory`） |
| `r0a-schema-draft.sql` | 生成的完整 R0a schema（唯一执行入口） |
| `r0a-schema-smoke.sql` | 139 项断言 + 负例（D-08 增加 25 项：token 配额、接入配置、凭证、用量越权）；单事务，结束回滚 |
| `r0a-concurrency-smoke.py` | 9 组多连接竞态（导出领取/租约接管/一次性凭证/投影乱序与重复投递/到期清扫/撤权窗口/管理读与结算交错/接入配置并发写/用量并发累加）；不变量被破坏时非零退出 |
| `admin-directory-concurrency.log` | 上述竞态脚本的原始输出（已纳入日志扫描范围） |
| `error-codes.json` | 冻结错误码目录 `r0a-errors-v3`（50 公开码）+ 104 个 SQL 异常映射；CI 直接扫描 `r0a-schema-draft.sql` 校验 |

### D2 契约资产

| 文件 | 用途 |
|---|---|
| `r0a-openapi-v1.yaml` | R0a 公开 API 子集：29 path/33 operation（管理读 6 path + D-08 用量 2 + 接入配置与凭证 6） |
| `r0a-api-types.d.ts` | `openapi-typescript 7.13.0` 生成的 TypeScript 类型 |
| `generate-client.mjs` | 从 OpenAPI 生成运行时客户端、参数/body/响应模型与漂移检查入口 |
| `r0a-client.mjs` | 生成的零依赖 fetch 客户端：cookie/CSRF、错误映射、SSE 解析、403 `csrf_invalid` 单次刷新重试；33 个 operation |
| `host-ports.mjs` | ADR-0021 五个 Host 端口（IdentityDirectory/Entitlement/Notification/BillingExport/ConnectorProvider）的方法与值形状；`createHostPorts` 缺方法、多方法、多字段、缺字段一律报错 |
| `we-meet-host-adapter.mjs` | WeMeet 适配器：把 P1-A 形状的目录/授权数据映射成 `sync_*` 投影载荷；缺 `subject_id`/`work_seat` 时报 gap，不猜映射，不把 token 配额换算成 cents 预算 |
| `stub-host.mjs` | 独立产品 stub host：同一组端口用本地数据应答，证明 Work 可脱离 WeMeet 取到同样的投影 |
| `mock-server.mjs` | 无依赖内存 mock：cookie/CSRF、输入/模板、任务/运行、SSE、成果、管理只读（目录投影驱动席位/预算/导出作业生命周期） |
| `scripts/ci-contract.mjs` | CI 门禁：冻结 33 个 operation、`$ref`、生成客户端/类型漂移、管理路径（12）与一次性凭证约束、错误码覆盖、全部测试 |
| `test/contract.test.mjs` | 12 组合同测试：golden path + 幂等/scope/取消/SSE/权限负例 + 成果只读 + 目录投影门控 + 审计导出生命周期 + 接入配置（owner-only/版本冲突/密钥不回显/吊销）+ 用量可见性 |
| `test/client.test.mjs` | 13 组生成客户端测试：golden path、SSE、401/403/404、CSRF、管理读与一次性下载凭证、参数校验、重试/删除的 revision 与幂等重放、code point 标题、接入配置与用量客户端 |
| `test/host-ports.test.mjs` | 9 组端口契约测试：端口/方法完整性、值校验、P1-A 缺口暴露、投影载荷、收窄提示、stub 可替换、静态边界（Work 不 import 适配器、适配器不写 SQL） |
| `package.json` | `npm test` / `npm run check` 入口（仅 Node 内置模块，无运行时依赖） |

## D2 运行

```bash
cd docs/plan/assets/work-r0a-design-2026-10-25

# 31 组测试（合同 10 + 客户端 12 + Host 端口 9）
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
- 一次性数据库；脚本会 `DROP SCHEMA work` 与相关角色。D-08 起 schema 含 `provider_credential` 的密文列，冒烟用假密文（`decode(...,'hex')`），不接真实 KMS。
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

# 多连接竞态（同一容器；需 python3 + psycopg 3）
pip install 'psycopg[binary]==3.3.3'
python r0a-concurrency-smoke.py        # 默认 127.0.0.1:55433，可用 R0A_DATABASE_URL 覆盖
```

预期冒烟最后输出 139 行 `ok = t` 并 `ROLLBACK`；竞态脚本输出 JSON 报告（9 组），`gate.violations` 为空时退出 0。

`admin-directory-concurrency.log` 命中仓库根 `.gitignore` 的 `*.log`：作为证据提交时需 `git add -f`（与 [work-temporal-slice](../work-temporal-slice-2026-10-25/README.md) 里的 `*-result.log` 同一做法）。

## 已验证

- D1（2026-10-26 修订）：空库应用 schema 成功；113/113 断言通过。修订新增：会话主体绑定（`app.subject_id`）、原因码枚举化、输入一次性绑定与共享引用不粉碎、删除/取消/转移的 owner+删除态校验、账本角色只读、worker 活动重放幂等（acquire/claim/reserve/finish/publish）、outbox 租约与跨组织 relay 策略、死信阻塞同聚合与 start 死信收尾 Run、运维重放/跳过审计、用户成果版本命令、启动前取消不 bump fence、cancel_requested 不得以成功收尾、unknown 原因码校验、成果编辑状态门槛（完成后或最近 Run 失败/取消只读）。原有覆盖：outbox 单聚合有序/退避/死信/重放审计、删除与粉碎 outbox、所有权转移、ops 权限、生命周期事件、标题编辑幂等/冲突/越权/事件无正文、导出审计、输入/提交幂等、scope 拒绝、直接 DML 拒绝、跨租户 RLS、派发、预算结算/修正、成果发布、采纳、审批、取消/重试、等待/恢复、unknown/reconcile、workflow-start/cancel outbox、task summary）。
- D1（2026-10-26 二次修订，`r0a-admin-directory.sql`）：新增 `work.audit_export` 表、`work_directory` 角色与 14 个领域函数，把 U2 方案 B 与 ADR-0021 从“只有 API 承诺”变成有落点的数据层。新增 24 项断言覆盖：投影只经 `sync_*` 写入（`work_api`/`work_worker` 无 EXECUTE、`work_directory` 无直接 DML）、修订号单调、跨组织上下文拒绝、目录同步不覆盖 `operator_suspended`、撤席位后新工作在 `create_input` 就被拒、非管理员读治理信息与创建导出被拒、`admin_overview` 的 cents 与 `budget_account` 逐字段相等、席位总数不受 keyset 分页影响、导出幂等重放与异体 409、时间范围/留存窗口校验、worker 租约独占与错误 worker 收尾拒绝、失败作业不可再领取、清扫过期计数、一次性下载令牌（服务存哈希、兑换一次即失效、重复发放拒绝）、跨组织读取不泄露作业存在性、审计轨迹不含正文。
- D1（2026-10-26 三次修订）：留存清扫 6 项（TTL 窗口、共享引用两个输入、只过期不粉碎、共享引用只投递一次、重复清扫返回 0、按组织作用域）+ 投影单调性写入谓词哨兵 1 项 → 114/114。
- D1（2026-10-26 四次修订，D-08）：金额账本改 token 配额（`quota_*`、去 `currency`/`price_version`、`wait_reason` 改 `quota`）；新增接入配置/凭证/用量日聚合与组织 Run 上限；新增 25 项断言覆盖 Run 级上限、演示组织周期硬上限、软账户不阻断、接入配置版本与跨组织拒绝、托管 Key 只写不回读、凭证吊销即时生效、用量本人可见与组织按模型汇总 → **139/139**。
- D1（并发竞态，9 组）：**同一批竞态测出并修复了一个真实缺陷**——`sync_org_projection`/`sync_member_projection` 用"先读校验、再 upsert"的写法，8 个乱序修订号并发时全部报"成功"，终态却停在 org 5 / member 6：高修订号被低修订号覆盖，已撤的席位可被重放复活。修法是把单调性写进 `ON CONFLICT … DO UPDATE … WHERE revision < EXCLUDED.revision`，返回行缺失即 `projection_revision_stale`；冒烟加哨兵，竞态脚本作判定。其余为通过项：领取 1 胜 9 拒、旧持有者收尾被拒、5 路兑换 1 成功、3 路清扫对 2 个共享引用各投一次粉碎、撤权提交前 6 笔穿透且提交后被拒、900 次管理读全部落在已结算分录的前缀和上；D-08 新增：6 路并发配置写 1 成功 5 冲突且始终单 active、10 路并发用量累加零丢失。
- D1：所有 `work` schema 函数为 `SECURITY DEFINER`，`work_api`/`work_worker` 无事实表直接 DML；所有租户表 `ENABLE` + `FORCE ROW LEVEL SECURITY`；`work_api`/`work_worker` 对 `work.audit_export` 无 SELECT（作业元数据只经领域函数出入）。
- D2：OpenAPI 3.1 校验通过（D-08 后 29 path/33 operation）；生成类型 `tsc --noEmit` 通过；合同测试 12/12、生成客户端 13/13、Host 端口 9/9，合计 **34/34**。
- D2：`scripts/ci-contract.mjs` 通过：33 个操作与冻结集一致、29 个 path、管理路径 12/12（6 读 + 用量 + 接入配置/凭证）、导出兑换必须带 `X-Download-Token` 且不存在 `download_url` 字段、生成客户端无漂移、类型包含全部 operation/引用的 schema、错误码目录与 mock（45 码）及 `r0a-schema-draft.sql`（104 码）双向一致、无自由文本 RAISE、`retryable` 仅 5xx/429；34/34 测试通过。
- D2/ADR-0021：`host-ports.mjs` + `we-meet-host-adapter.mjs` + `stub-host.mjs` 证明边界可执行：缺 `subject_id`/`work_seat` 时报 gap（不猜映射、不把 token 配额当席位或金额），BillingExport 只收 token 字段、金额字段报 `incompatible_source`，同一套端口在 stub host 上产出同形状投影；静态检查要求 Work 运行面文件不 import 适配器、不出现他系统 schema 名，且适配器不写 SQL。
- CI：`.github/workflows/work-r0a-gates.yml` 已定义 contract（含 schema 再生成无漂移）、db-smoke（PG16 schema + 139 项冒烟 + 9 组竞态）、ops-telemetry（规则再生成 + 模型测试 + promtool 校验/单测）、runtime-frontend、log-scan 六个 job；**已在远端运行**——PR #7（commit `62affea4b`）首次跑 6/6 通过（31s）；首跑曾败于 `orchestration-contract` 缺 PyYAML，已在同一 PR 修复。仓库全量流水线也已跑绿（head `9494f79b0`：meet Workflow 15/15、Release guard 通过，PR #7 25/25 检查通过且可合并）。

## 未验证

D1：连接池租户上下文、生产数据量/索引、迁移回滚、真实 Content Store、Temporal、真实模型/供应商、留存删除、operator 停用、P1-A 集成、用户上传/编辑流程。D-08 的 KMS 信封加密、密钥轮换/吊销与网关解密只在数据层用假密文验证；真实 KMS、密钥泄露应急、配置探测请求与上游 usage 归一未测。管理读/投影/导出/清扫/接入配置/用量累加的多连接竞态已实测（同瞬时冲突下的不变量），但真实 IdP 的迟到与重放节奏、批量回填窗口、多副本 worker 长跑、跨库时钟偏差下的租约仍未测；投影权威数据源仍是冒烟里的固定 fixture，不是真实 P1-A/IdP 返回。
D2：真实 cookie/CSRF 签发、真实 SSE 网关/背压/多连接、真实持久化、真实鉴权、CORS、桌面/移动、性能/模糊测试、生成客户端接入真实前端、P1-A 真实字段接入；D-08 的接入配置写接口只在内存 mock 上验证，未接真实 KMS/STS 与上游连通探测；Host 端口适配器与 stub host 只在 fixture 上验证，未接真实身份/目录/通知/计费服务；导出作业的真实文件生成（Content Store 写入、行数上限、失败重试）不在 R0a 设计物内。

## 与其他文档

- 设计说明：[../../work-r0a-data-design-2026-10-25.md](../../work-r0a-data-design-2026-10-25.md)
- 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
- 完整 DDL：[../../work-data-model-ddl-draft-2026-10-25.md](../../work-data-model-ddl-draft-2026-10-25.md)
- API 契约：[../../work-api-contracts-2026-10-25.md](../../work-api-contracts-2026-10-25.md)
