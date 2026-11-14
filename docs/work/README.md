# Work 模块

> **代码、迁移、契约和测试是详细设计的权威来源；文档不复制实现细节，只保留架构决策、边界、操作约束和当前状态。**
>
> 本目录是 Work 文档的唯一阅读入口。已实现设计的基线快照与历史台账在 [archive/](archive/README.md)；未落地需评审的 R0b 设计与安全边界决策在 [design/](design/)；运维参考（runbook/drill/glossary）在 [ops/](ops/)。CI 保护机器契约与代码行为，文档侧只做漂移轻检查（链接/锚点/引用存在性、status 生成一致性）。

## Work 是什么

Work 是 we-meet 的 AI 任务执行模块：用户写一个目标（Composer），系统编排一次或多次执行（Run），产生可验收的成果（Artifact），并对预算、权限、审计负责。它不是会议 AI 的延伸，而是一个可剥离的独立产品边界（[ADR-0021](../adr/0021-work-standalone-product-boundary.md)）。

## 当前范围与状态

当前状态由 `scripts/work-status.mjs` 生成 [status.json](status.json) 与 [status.md](status.md)：生产/决策事实记录在 [status.inputs.json](status.inputs.json)，动态试点门禁与仓库迁移 tip 由脚本现算（CI 校验生成无漂移）。一句话：**R0a 已实现并部署试点环境；R0b 设计完成自查、外部审计未执行、实现部分开始；不允许真实客户数据，试点尚未开始。**

| 阶段 | 范围 | 状态 |
|---|---|---|
| R0a | 云端文本任务：Composer、我的工作、任务工作区、成果验收、预算/审计、管理只读子集 | 已实现、已部署试点环境 |
| R0b | 本机执行（设备面）、可委派权限、治理、审批、token 护栏 | 设计自查完成、外部审计未执行；M1a 设备迁移＋M1b REST 面已落仓库（迁移 0017–0045，0040–0045 未 rollout），M2–M5 未实现 |
| R1–R5 | 套件/技能、连接器、项目/链式、富成果、协作/自动化 | 仅产品/UX/架构方向，未实现 |

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
| [design/](design/) | R0b 详细设计（需评审）＋安全边界决策（host-wire/threat-model）；M1a/M1b 已落仓库，M2–M5 未实现，长文整体仍为签署权威（收敛条件见下）；已实现 R0a 设计基线见 [archive/design-baseline/](archive/design-baseline/) |
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
| 迁移 | `src/work/migrations/` | baseline 0001/0002 + 增量 0003–0045，manifest.json |
| 部署 | `src/work/deploy/ecs/`、`deploy/aliyun/` | systemd unit、发布/rollout/verify 脚本、Temporal |
| 契约/门禁资产 | `docs/plan/assets/work-*/` | OpenAPI、错误码、策略、pilot-checklist、CI 门禁 |

## 权威来源表

凡是不在这张表里的重复说明，都应删除或归档——以代码/契约/测试为准。

> **R0b 详细设计收敛条件（文档重构活义务，保持开放）**：design/ 的 R0b 长文覆盖整个 R0b，是 M2–M5（桌面端／设备网关／前端消费者／真签名验证）这些「代码尚不存在」部分的签署权威，故整体尚不能归档。M1a/M1b 已落仓库（未 rollout），其详细设计已由代码/迁移/契约/测试取代为权威。**关闭条件＝M2–M5 实现并 rollout 后，长文整体收敛为代码权威并按归档纪律移入 [archive/design-baseline/](archive/design-baseline/)**（与 R0a 基线同路径）；在此之前不归档、不删 prose。

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
# 契约 / 类型 / 文档漂移门禁（231＋38＋24，自动发现 test/*.mjs；含 status 生成漂移校验）
node docs/plan/assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs

# ops / pilot / telemetry（34）
(cd docs/plan/assets/work-r0a-ops-2026-10-25 && node --test ops-model.test.mjs telemetry.test.mjs pilot-ops.test.mjs)

# 重新生成 status.json / status.md（改 status.inputs.json 后跑）
node scripts/work-status.mjs

# 试点 go/no-go 现读
# 命令见 status.json 的 pilot_gate.command 字段
```

CI 见 `.github/workflows/work-r0a-gates.yml`（8 个 job）与 `work-r0a-required.yml`，仅在 PR 或 `aliyun-dev` push 且命中 Work 路径时触发。

## 当前是否允许生产 / 试点

**不允许真实客户数据，试点尚未开始。** 接任何真实客户数据前必须完成外部安全审计（J39，当前未执行）；试点 go/no-go 当前为 no-go（C17 SLO 未实测）。详见 [security.md](security.md) 与 [status.md](status.md)。