# R0a 实施状态总结

> 日期：2026-10-27
> 分支：dev/work-r0a
> 基线：[实施计划](work-r0a-implementation-plan-2026-10-27.md)
> 本次修订：2026-10-27 按验收标准逐项核对代码，修正过度声明与错误路径（见 §5）

## 0. 状态口径

本文按三级标注，不混称：

| 标记 | 含义 |
|---|---|
| **已验证** | 代码存在且有实质实现，并有本地或 CI 可复现的通过证据 |
| **未验证** | 代码/配置存在且有实质实现，但缺少运行证据（无环境、未部署、未演练） |
| **未实现** | 不存在，或只有契约/mock 而无生产实现 |

"契约阶段验收"与"可试点验收"是两套标准，分别计数。E4/E5/E6 的计划验收标准只覆盖契约阶段。

## 1. Epic 实施状态

### E1 数据层落库 — 已验证（7 项验收中 6 项）

| 验收项 | 状态 | 证据 |
|---|---|---|
| `migrate work` 成功 | 已验证 | `work/migrations/0001_create_work_roles.py`（7 角色幂等 + NOLOGIN 校验）、`0002_initial_r0a_schema.py` |
| `migrate work zero` 回滚 | 已验证 | `0002_initial_r0a_schema.py:44` `reverse_sql="DROP SCHEMA IF EXISTS work CASCADE"`，`atomic=True` |
| 148 项冒烟 | 已验证 | `work/tests/test_r0a_migrations.py:81`（psql 子进程跑设计资产，单一事实源） |
| 9 组竞态 | 已验证 | `work/tests/test_r0a_concurrency.py:26` |
| CI 迁移与测试步骤 | 已验证 | `.github/workflows/work-r0a-gates.yml:121` `backend-migration` job |
| 角色脚本 staging 验证 | **未验证** | `deploy/aliyun/work-roles.sql` + `apply-work-roles.sh` 已就绪，待 DBA 在 staging 执行并把 `work_owner` 授给迁移身份 |
| 迁移 runbook | 已验证 | `docs/plan/work-r0a-migration-runbook.md` |

`work` 已注册：`meet/settings.py:472` INSTALLED_APPS；`settings.py:126` `search_path=public,work`。

### E2 API 服务 — 已验证（9 项验收全满足）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 33 operation 可调用 | 已验证 | `work/api/urls.py` 29 path；`work/tests/test_api.py:567` 断言 `len(paths) == 33` 且逐条 resolve |
| 错误码映射 | 已验证 | `work/api/errors.py`；CI `work-r0a-gates.yml:176` 比对 `work/api/error-codes.json` 与设计资产 |
| 幂等与去重 | 已验证 | `test_api.py:632` input 幂等、`:685` task submit 幂等 |
| 一次性下载令牌 | 已验证 | `test_api.py:432` 审计导出单次下载、`:751` artifact 下载 |
| 管理只读 6 接口 | 已验证 | `work/api/views/admin.py`；`test_api.py:217` 含非管理员边界 |
| 目录投影同步 | 已验证 | `work/jobs/directory_sync.py`；`test_api.py:309`、`:346` |
| 凭证加解密 org 隔离 | 已验证 | `work/security/credential_cipher.py` AES-GCM + 按 org HKDF 派生，密钥缺失 fail-closed；`test_api.py:366` |
| `ops_cancel_run` 工单+幂等 | 已验证 | `work/management/commands/ops_cancel_run.py`；`test_api.py:490` |
| API 覆盖率 > 80% | 已验证 | `work/api` 88% |

### E3 SSE 网关与 outbox relay — 已验证（6 项验收全满足）

| 验收项 | 状态 | 证据 |
|---|---|---|
| SSE 连接与恢复 | 已验证 | `work/api/views/run.py:74` `StreamTaskEventsView` |
| Last-Event-ID / 409 resync | 已验证 | `test_api.py:873` |
| Outbox relay 投递 | 已验证 | `work/jobs/outbox_relay.py`；`test_api.py:899` |
| 死信阻塞与重放/跳过 | 已验证 | `work/management/commands/work_outbox_dead_letter.py`；`test_api.py:981` |
| 生命周期事件 | 已验证 | 由 SQL 领域函数写入 `work.task_event`/`work.outbox`；`test_api.py:817` |
| SSE 覆盖率 > 70% | 已验证 | 含在 `work/api` 88% 内 |

六类后台作业实现落点：`outbox_relay`（jobs + `work_outbox_relay` 命令）、死信运维（`work_outbox_dead_letter`）、`directory_sync`、`audit_export`、`expiry_sweep`、content_shred（经 outbox payload 走 `api/content_store.delete`）。

### E4 编排 — 契约阶段已验证；真实执行未验证

**契约阶段验收（4 项全满足）**

| 验收项 | 状态 | 证据 |
|---|---|---|
| RunWorkflow/Activities 契约 | 已验证 | `work/orchestration/contracts/run_workflow.py`、`activities.py`；`test_contracts.py:25` |
| 六类后台作业契约 | 已验证 | `work/jobs/contracts/` 六文件；`test_contracts.py:36` |
| Mock 实现可调用 | 已验证 | `work/orchestration/mock/temporal_mock.py`、`local_workflow.py`；`test_api.py:945` 本地纵切跑到 artifact + usage |
| 故障矩阵子集文档化 | 已验证 | D3 设计文档 + `jobs/contracts/base.py` |

**真实化进展（超出契约阶段验收，属下一阶段）**

| 项 | 状态 | 说明 |
|---|---|---|
| Temporal 客户端 | 已提交 | `work/orchestration/temporal_client.py`（start/cancel/query/signal） |
| relay 对接 Temporal | 已提交 | `work/jobs/outbox_relay.py` 分派 `start_workflow`/`cancel_signal`，含"已启动"幂等吞错 |
| Django 配置 | 已提交 | `meet/settings.py:961` `TEMPORAL_ADDRESS`/`NAMESPACE`/`API_KEY`/`TLS` |
| Temporal 部署清单 | 未验证 | `deploy/aliyun/temporal/`（server/worker/service/configmap + 备份 CronJob + mTLS 变体）；本机无 work-staging kubeconfig，集群状态无法复核 |
| Worker 16 activity 对齐 schema | 已提交 | `deploy/aliyun/temporal/worker/worker.py`，已按实际 schema 修正列名、函数签名与 artifact 两表写入 |
| **端到端 workflow 执行** | **未验证** | 见 §3 阻塞项：worker 在本机 segfault，**至今没有一次完整 queued → succeeded 的记录** |
| mTLS | 未实现（已决策推迟） | auto-setup 限制 + staging 风险可控，推迟到生产部署 |

### E5 Runtime 与出口 — 契约阶段已验证；生产路径仍为 mock

**契约阶段验收（4 项全满足）**

| 验收项 | 状态 | 证据 |
|---|---|---|
| Work Adapter 契约 | 已验证 | `work/runtime/contracts/work_adapter.py`；`test_contracts.py:102` |
| 模型网关契约 | 已验证 | `work/runtime/contracts/model_gateway.py`；`test_contracts.py:131` |
| Content Store 契约 | 已验证 | `work/content/contracts/content_store.py`；`test_contracts.py:52` org 隔离 |
| Mock 实现可调用 | 已验证 | `work/content/mock/local_filesystem.py`、`work/runtime/mock/` |

**可试点缺口**

| 项 | 状态 | 证据 |
|---|---|---|
| Content Store 生产实现 | **未实现** | `work/api/content_store.py:3` 直接 import `LocalFilesystemContentStore`；`work/jobs/audit_export.py:1` 注明"E5 swaps the store" |
| 真实模型供应商 | **未实现** | `work/api/views/task.py:41` `DEFAULT_MODEL_ROUTE = {"provider": "mock", "model": "mock-text-v1"}` |
| 静态凭证加密 | 已验证 | 已在 E2 步骤 2.6 落地（`security/credential_cipher.py`） |
| 主密钥托管与轮换演练 | **未验证** | 属 E5 范围（开发准入单 L07/L13），未执行 |

### E6 前端 — 契约阶段已验证；UI 不完整

**契约阶段验收（3 项全满足）**

| 验收项 | 状态 | 证据 |
|---|---|---|
| API 客户端契约 | 已验证 | `features/work/contracts/api.ts`(254 行)、`api/client.ts`(246 行)；`api/client.test.ts` |
| SSE 客户端契约 | 已验证 | `features/work/contracts/sse.ts` |
| TypeScript 类型检查 | 已验证 | 前端测试 1713 通过 |

**可试点缺口**

`src/frontend/src/features/work` 共 11 文件 2197 行：`WorkRoute.tsx`(546，Mock UI)、`WorkLiveRoute.tsx`(596，React Query + 真实 API)、`mock/mockClient.ts`(199)。

对照 E6 目标「Composer / 我的工作 / 任务工作区 / Inbox、管理只读」：

| 项 | 状态 |
|---|---|
| 任务提交与工作区主流程 | 部分（集中在两个 Route 组件内，未拆分为设计稿的页面结构） |
| **管理只读 UI** | **未实现**（后端 6 接口齐备，前端无对应页面） |
| 旧链接只读 | 未验证 |
| 文案定稿 | 未实现（等 U1 报告与 C05） |
| a11y (axe) | 已验证 | `e2e/work-a11y.spec.ts`、`WorkRoute.a11y.test.tsx` |

### E7 可观测与供应链 — 实现已验证；部署未验证

**代码与配置均为实质内容，非占位**

| 项 | 状态 | 证据 |
|---|---|---|
| 指标上报 | 已验证 | `work/observability/metrics.py`；`test_observability.py:23` 指标名为契约子集 |
| 日志字段守卫 | 已验证 | `work/observability/logging.py`；`test_observability.py:34` 拒绝正文字段 |
| 日志正文泄露扫描 | 已验证 | `work/observability/log_scan.py`；`test_observability.py:41` 命中正文与凭证 |
| 分布式追踪 | 已验证（代码） | `work/observability/tracing.py` |
| Prometheus 规则 | 已验证（文件） | `deploy/observability/prometheus-rules.yaml`(459 行)，与设计资产 `work-r0a-ops-2026-10-25/prometheus-rules.yaml` **逐字节一致** |
| Grafana 看板 | 已验证（文件） | `deploy/observability/grafana-dashboards/work-overview.json` 5 panel，引用 `work_api_requests_total`/`work_outbox_lag_seconds`/`work_quota_*`/`work_sse_events_total` |
| OTel Collector | 已验证（文件） | `deploy/observability/otel-collector.yaml` 含 `attributes/redact` 删除 goal/background/content |
| 供应链门禁 | 已验证 | `.github/workflows/supply-chain.yml` |

**未验证项**：验收标准里「Prometheus 规则**生效**」「Grafana 看板**显示**指标」「OTel 追踪**正常**」三条都要求运行态证据。本机只有 `docker-desktop` context，**无 work-staging kubeconfig**，无法复核是否已 apply 到集群，也无看板截图或查询返回值。

### E8 试点准备 — 资产已验证；演练未执行

| 验收项 | 状态 | 证据 |
|---|---|---|
| 组织开通流程 | 已验证（脚本） | `scripts/onboarding/create-org.sh`（带 `WORK_ONBOARDING_CONFIRM=1` 确认闸，调 `sync_org`）、`assign-seats.sh` |
| 黄金任务定义 | 已验证 | `docs/plan/assets/work-r0a-ops-2026-10-25/golden-tasks.json`；CI `work-r0a-gates.yml:76` 校验定义 |
| 黄金任务演练（成功率 > 95%） | **未验证** | 未执行，等 2026-11-06 环境与档期 |
| 切换/回滚演练 | **未验证** | `cutover-plan.json` 已定义，未执行 |
| 支持与删除流程签收 | **未验证** | `work-r0a-pilot-operations-runbook-2026-10-26.md` 已就绪，待签 |

## 2. 测试状态

| 套件 | 结果 | 口径 |
|---|---|---|
| E1 冒烟（设计资产 + 迁移产物） | 148/148 | psql 执行，断言数以脚本自身输出为准 |
| E1 竞态 | 9/9 | 独立一次性 scratch 库 |
| Work pytest | 39/39 | `work/tests` 共 39 个 `test_` 函数：migrations 5、api 23、contracts 7、observability 3、concurrency 1 |
| `work/api` 覆盖率 | 88% | — |
| 前端单测 | 1713 | — |
| a11y (axe，含颜色对比) | 通过 | — |
| **E4 真实 Temporal 端到端** | **未通过** | 见 §3 |

真实 HTTP（Cookie+CSRF）已走通 bootstrap → input → preview → submit → run → artifact → SSE → usage → acceptance，但 run 执行走的是 `local_workflow` 本地纵切，不是 Temporal。

## 3. 阻塞项

### B1 — E4 Worker 端到端执行未通过（新增，阻塞试点）

**现象**：worker 启动正常（16 activity 注册成功、DB 池建立、监听 `work-r0a-run`），workflow 能被领取并进入 `prepare_run` activity，随即进程 segfault（exit 139）。

**已排除**：
- SQL 本身正确 —— 同一查询用 psql 和独立 asyncpg 脚本均正常返回
- schema 对齐 —— 16 activity 的列名/函数签名已逐一核对修正
- 测试数据 —— org/org_policy/quota_account/input/task/snapshot/run 均创建成功

**定位**：Python 3.13 + asyncpg 0.32.0 + temporalio 1.34.0 在 Windows 下，activity 内执行异步 DB 操作时崩溃。属环境/运行时兼容问题，非业务代码缺陷。

**候选处置**（待定）：降到 Python 3.11/3.12；activity 内改用同步 psycopg2；worker 跑在 Linux 容器内。

### B2 — 无 work-staging 集群访问

本机仅 `docker-desktop` context。影响：E1 角色脚本 staging 验证、E4 Temporal 部署复核、E7 规则/看板生效验证，全部无法本地取证。

### B3 — 生产路径仍为 mock

Content Store 与模型供应商两处（见 E5）。试点前必须替换。

### B4 — 外部依赖未关闭

U1（可用性报告 2026-11-27）、C22/C24/C27（环境与档期，2026-11-06），已转签收单。

## 4. 完成度结论

**按契约/mock 阶段口径**：E1–E6 验收标准满足；E7 的 3 项运行态验收、E8 的 3 项演练验收不满足。

**按可试点口径，4 个硬缺口**：

1. E4 真实 workflow 端到端从未跑通（B1）
2. E5 Content Store 与模型供应商仍为 mock（B3）
3. E6 管理只读 UI 缺失
4. E7 Prometheus/Grafana/OTel 部署未验证（B2）

## 5. 本次修订纠正的过度声明

上一版存在以下不实表述，已更正：

| 原表述 | 问题 | 更正 |
|---|---|---|
| `E7 可观测与供应链 ✅ COMPLETE` | 「规则生效/看板显示/OTel 正常」三项需运行态证据，无集群访问无法验证 | 拆为"实现已验证／部署未验证" |
| `E8 试点准备 ✅ COMPLETE (脚本与文档)` | 脚本齐 ≠ 演练通过；黄金任务与切换/回滚演练均未执行 | 拆为"资产已验证／演练未执行" |
| `E4 编排 ✅ COMPLETE` | 契约阶段确已完成，但真实执行未通过，标 COMPLETE 会掩盖 B1 | 拆为"契约阶段已验证／真实执行未验证" |
| `E5 ✅ COMPLETE (契约 + Mock)` | 未点明生产路径仍指向 mock | 补 E5 可试点缺口表 |
| `E6 ✅ COMPLETE (Mock + Live)` | 未点明管理只读 UI 缺失 | 补 E6 可试点缺口表 |
| `work/api/idempotency.py` | **文件不存在**，幂等逻辑分散在视图与 `submission_dedup` | 删除该路径，改引测试证据 |
| `work/api/download.py` | **文件不存在**，下载令牌逻辑在 `views/artifact.py`/`views/admin.py` | 删除该路径，改引测试证据 |
| `deploy/aliyun/temporal/backup-cronjob.yaml` | **路径错误** | 实际为 `temporal-db-backup-cronjob.yaml` |
| 「未提交文件」清单 | E4 代码已于本日提交（`d83576fa9`…`68e30c2ae`） | 删除该节 |

另有计划文件清单与实现落点不一致（功能在、位置不同，非缺口）：`input.py`/`approval.py` 合并进 `task.py`/`artifact.py`；`error_codes.py` 实际为 `errors.py`；`test_r0a_schema_smoke.py` 断言并入 `test_r0a_migrations.py`；未单建 `work/sse/`、`work/events/`、`jobs/relay_worker.py`（计划正文已回写说明）。

## 6. 下一步行动

1. **解 B1**：选定 worker 运行环境（Python 降版 / 同步驱动 / Linux 容器），跑通一次完整 queued → succeeded 并留存 run 终态与 artifact 记录
2. **解 B2**：取得 work-staging kubeconfig，复核 Temporal 部署与 E7 规则/看板，补运行态证据
3. **E5 真实化**：Content Store 换平台对象存储；接入真实供应商网关（客户自带账号，D-08）
4. **E6 补管理只读 UI**：对齐后端 6 接口
5. **E7 补验证证据**：规则 apply 确认、看板查询返回、OTel trace 样本
6. **E8 演练**：黄金任务 + 切换/回滚（等 2026-11-06）
7. **E1 收尾**：DBA 在 staging 执行角色脚本

---

**更新记录**：2026-10-27 初版；2026-10-27 按验收标准逐项核对代码，修正 E4–E8 过度声明、两处不存在的文件路径与一处错误路径，新增状态口径与阻塞项 B1–B4
