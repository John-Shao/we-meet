# Work 模块

> **代码、迁移、契约和测试是详细设计的权威来源；文档不复制实现细节，只保留架构决策、边界、操作约束和当前状态。**
>
> 本目录是 Work 文档的唯一阅读入口。已实现设计的基线快照与历史台账在 [archive/](archive/README.md)；未落地需评审的 R0b 设计与安全边界决策在 [design/](design/)；运维参考（runbook/drill/glossary）在 [ops/](ops/)。CI 保护机器契约与代码行为，文档侧只做漂移轻检查：短文档（顶层＋decisions）与 design/ops 长文校验链接/锚点/引用存在性与 status 生成一致性；**archive/ 只保证可追溯，不做链接有效性检查**——历史快照里的失效链接按原文保留，不为了修链而改归档 prose。

## Work 是什么

Work 是 we-meet 的 AI 任务执行模块：用户写一个目标（Composer），系统编排一次或多次执行（Run），产生可验收的成果（Artifact），并对预算、权限、审计负责。它不是会议 AI 的延伸，而是一个可剥离的独立产品边界（[ADR-0021](../adr/0021-work-standalone-product-boundary.md)）。

## 当前范围与状态

当前状态由 `scripts/work-status.mjs` 生成 [status.json](status.json) 与 [status.md](status.md)：生产/决策事实记录在 [status.inputs.json](status.inputs.json)（每项带 reason／证据路径／核实日期，脚本校验证据存在），动态试点门禁与仓库迁移 tip 由脚本现算（CI 校验生成无漂移）。`facts_as_of` 是事实核实日期，`generated_at` 是生成日期，两者不同义。一句话：**R0a 已实现并部署试点环境；R0b 设计完成自查、外部审计未执行、实现部分开始；不允许真实客户数据，试点尚未开始。**

| 阶段 | 范围 | 状态 |
|---|---|---|
| R0a | 云端文本任务：Composer、我的工作、任务工作区、成果验收、预算/审计、管理只读子集 | 已实现、已部署试点环境 |
| R0b | 本机执行（设备面）、可委派权限、治理、审批、token 护栏 | 设计自查完成、外部审计未执行；M1a 设备迁移＋M1b REST 面已落仓库（未 rollout），M3 设备 agent＋服务端网关部分已落仓库（未 rollout、未接生产消费），M2/M4/M5 未实现；迁移 tip 见 [status.json](status.json) |
| R1–R5 | 套件/技能、连接器、项目/链式、富成果、协作/自动化 | 仅产品/UX/架构方向，未实现 |

> **2026-11-20 更正**：本页早期的「M2 未实现／M3 仅部分」不能替代后续分批登记；桌面壳与设备执行脊的已落范围、夹具证据和仍延后项以 [执行面设计单](design/work-r0b-execution-face-design-2026-11-19.md) 的批次登记为准。本页下方同类阶段概括也按此读取，不据此扩大生产准入或 rollout 授权；迁移与生产状态仍只取 [status.json](status.json)。

R0a **不含**：本机执行、连接器、项目/链式、手工审批 UI（审批函数内部保留给 R0b/R2/测试）。

## 文档结构

| 文档 | 职责 |
|---|---|
| [README.md](README.md) | 入口、范围、权威来源表（本文） |
| [architecture.md](architecture.md) | 稳定架构：模块边界、领域对象、信任边界、关键不变量 |
| [security.md](security.md) | 安全属性、信任边界、当前验证状态、客户数据准入 |
| [operations.md](operations.md) | 可操作运维步骤：部署、迁移、备份、回滚、告警、go/no-go |
| [status.json](status.json) / [status.md](status.md) | 当前状态（`scripts/work-status.mjs` 生成；事实输入 [status.inputs.json](status.inputs.json)） |
| [decisions/](decisions/README.md) | 架构决策记录（ADR）索引 |
| [design/](design/) | R0b 详细设计（需评审）＋安全边界决策（host-wire/threat-model）；M1a/M1b 已落仓库、M3 部分已落仓库，M2/M4/M5 未实现；长文**按章节收敛**（已实现章节移入归档，未实现章节仍为签署权威，条件见下）；已实现 R0a 设计基线见 [archive/design-baseline/](archive/design-baseline/) |
| [ops/](ops/) | 运维参考长文（runbook/drill-checklist/glossary/pilot-ops）；[operations.md](operations.md) 是其精简操作入口 |
| [archive/](archive/README.md) | 历史快照，只读追溯，不参与当前设计阅读 |
| [work-project.md](work-project.md) | 项目纯索引：状态指向 status，开放裁定指向 decisions/open-rulings |

## 服务与目录结构

| 层 | 位置 | 说明 |
|---|---|---|
| Go 控制面 | `src/work/cmd/`、`src/work/internal/` | 13 个入口（work-api/worker/relay/authz/content-proxy/egress/migrate/reconcile/export/replay/directory-sync/provider-setup/e2e-seed） |
| Node Runtime | `src/work/node/` | Pi supervisor + 每 Run 子进程；模型出口经 work-egress |
| Host 集成 | `src/backend/core/api/work_host.py` | Django，mTLS 会话验真与目录投影 |
| 前端 | `src/frontend/src/features/work/r0a` | `/work` 路由 |
| 迁移 | `src/work/migrations/` | baseline＋增量，manifest.json＋catalogs 钉 checksum；仓库/现网 tip 见 [status.json](status.json) |
| 部署 | `src/work/deploy/ecs/`、`deploy/aliyun/` | systemd unit、发布/rollout/verify 脚本、Temporal |
| 契约/门禁资产 | `docs/plan/assets/work-*/` | OpenAPI、错误码、策略、pilot-checklist、CI 门禁 |

## 权威来源表

凡是不在这张表里的重复说明，都应删除或归档——以代码/契约/测试为准。

> **R0b 详细设计收敛条件（文档重构活义务，保持开放）**：design/ 的 R0b 长文覆盖整个 R0b，其中 M2（桌面壳本机能力）／M4（前端消费者）／M5（EV 与验收）这些「代码尚不存在」部分仍是签署权威。**收敛按章节判定，不必等整个 R0b 完成**：某章节对应的实现一旦落仓库、并由代码/迁移/契约/测试取代为权威，该章节即可标注为历史记录并移入 [archive/design-baseline/](archive/design-baseline/)（原文逐字保留、仅调整相对链接）；**仍活的义务（延后项、重开条件、未测控制缺口）必须留在活文档或 [work-project.md](work-project.md) 状态桩，不得随归档隐藏**。M1a 设计单已按此收敛（design/ 同名文现为指针＋仍活义务，全文快照在归档）；control/device 等混合长文按章节逐步收敛，未实现章节在此之前不归档、不删 prose。

| 内容 | 权威来源 |
|---|---|
| API | `docs/plan/assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml` + `src/work/internal/api/*_test.go` |
| 数据模型 | `src/work/migrations/` + `src/work/internal/migrate/` 测试 |
| 状态转移 | SQL 领域命令 + `src/work/internal/api/state_machine_pg_test.go` + 资产 `state-matrix.json` |
| Workflow | `src/work/internal/runflow/` + `workflow_test.go` |
| 权限 / 隔离 | RLS 迁移 + `tenant_isolation_sweep_pg_test.go` + `src/work/internal/authz/` |
| 错误码 | `src/work/contracts/error-codes.json` + `src/work/internal/apierr/` 测试 |
| 当前发布状态 | [status.json](status.json) + `goNoGo()`（见 [operations.md](operations.md)） |
| 运维流程 | [operations.md](operations.md) |
| 架构决策 | [decisions/](decisions/README.md) 与 `docs/adr/`（0005–0021） |

## 本地如何运行

Work 控制面测试需要一次性/隔离的 PostgreSQL 16（**不要指向共享库**）：

```bash
# Go 全量（migrate + RLS + API + directory；串行）
(cd src/work && WORK_TEST_PG_URL="postgres://postgres:postgres@localhost:55435/postgres?sslmode=disable" \
  go test ./... -p 1 -count=1)
```

Temporal 切片需要 Docker Compose / Temporal dev（Windows 主机不能直接跑 Temporal SDK）。部署与运行时操作见 [operations.md](operations.md)。

## 如何运行测试 / 门禁

```bash
# 契约 / 类型 / 文档漂移门禁（235＋38＋24，自动发现 test/*.mjs；含 status 生成漂移校验）
node docs/plan/assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs

# ops / pilot / telemetry（34）
(cd docs/plan/assets/work-r0a-ops-2026-10-25 && node --test ops-model.test.mjs telemetry.test.mjs pilot-ops.test.mjs)

# 重新生成 status.json / status.md（改 status.inputs.json 后跑）
node scripts/work-status.mjs

# 只校验生成物无漂移（CI 也跑这一步；generated_at 不参与比对）
node scripts/work-status.mjs --check

# 试点 go/no-go 现读
# 命令见 status.json 的 pilot_gate.command 字段
```

CI 见 `.github/workflows/work-r0a-gates.yml`（8 个 job）与 `work-r0a-required.yml`，仅在 PR 或 `aliyun-dev` push 且命中 Work 路径时触发；**生成脚本 `scripts/work-status.mjs` 本身也在触发路径内**，改生成逻辑同样会跑门禁。

## 当前是否允许生产 / 试点

**不允许真实客户数据，试点尚未开始。** 接任何真实客户数据前必须完成外部安全审计（J39，当前未执行）；试点 go/no-go 当前为 no-go（C17 SLO 未实测）。详见 [security.md](security.md) 与 [status.md](status.md)。