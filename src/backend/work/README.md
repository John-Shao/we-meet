# Work 办公模块

Work 是独立于会议生命周期的办公任务执行中心：用户提交目标，由受控 Agent 在云端或用户本机执行，交付可编辑的 Markdown 成果与私有文件。当前只保留 `office_agent` 任务；材料上传、沟通准备及其执行器已于 2026-10-25 移除，历史 `communication` 行不删除也不展示。

## 能力

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 云端办公 Agent | `POST /api/v1.0/work/tasks/` | 服务端 outbox 领取任务，经独立 Gateway 执行；支持取消、事件恢复、成果版本与采纳 |
| 本机 / 远程执行 | `local/*` | 桌面端登记设备与工作空间，领取任务后在本机执行；原始文件与绝对路径不上传 |
| 成果复核 | `runs/<id>/reviews/` | 独立 Pi 只读复核已同步的成果文件；单独授权、预算与取消 |
| 使用量预算 | `capabilities/` | 按账号和组织预留预算，成功后写入 `AIUsageRecord` |
| 租户准入 | `WORK_TENANT_ACCESS_ENABLED` | 组织 entitlement、成员 grant、审计与导出；关闭时沿用账号白名单 |

任务输入只有 `goal`（≤2000 字）与可选 `background`（≤4000 字），不再选择或解析云端材料。`Idempotency-Key` 必须为 UUID；重复提交返回同一任务/运行，内容不一致返回 `409 idempotency_conflict`。

## 运行契约

- 云端 Agent 契约 `work-agent/v1`，执行器版本 `office-agent-v1`。请求体包含目标、空 `files`、超时与预算；Gateway 必须返回 `idempotency`、`cancel`、`cumulative_budget`、`provider_metering` 能力。
- 本机契约 `work-device/v1`，本机适配器契约 `work-local/v1`。`claim` 返回空文件列表、预算和一次性 ticket；报告按 `seq` 单调递增，正文只在本机。
- 复核契约 `pi-review-v1`。只选择已显式同步到云端的成果文件；创建时冻结目标、选定文件与预算，证据引用必须匹配文件 SHA-256。
- 终止状态为 `succeeded`、`failed`、`canceled`、`disconnected`。取消优先于迟到结果；传输不确定时用同一 UUID 查询，不自动创建第二次付费调用。

## API

```
GET  /api/v1.0/work/capabilities/
GET/POST /api/v1.0/work/tasks/
GET  /api/v1.0/work/tasks/{id}/
POST /api/v1.0/work/tasks/{id}/retry/
GET  /api/v1.0/work/runs/{id}/events/?after=
POST /api/v1.0/work/runs/{id}/cancel/
GET/POST /api/v1.0/work/runs/{id}/artifact/
POST /api/v1.0/work/runs/{id}/adopt/
GET  /api/v1.0/work/runs/{id}/download/?version=
GET  /api/v1.0/work/runs/{id}/files/
GET  /api/v1.0/work/runs/{id}/file-download/?name=
GET/POST /api/v1.0/work/runs/{id}/reviews/
POST /api/v1.0/work/runs/{id}/reviews/{review_id}/cancel/
POST /api/v1.0/work/local/devices/ | local/workspaces/ | local/tasks/
POST /api/v1.0/work/local/inbox/ | local/remote-tasks/
POST /api/v1.0/work/local/runs/{id}/claim/ | report/ | sync/
```

管理接口位于 `admin/grants/`、`admin/entitlement/` 与 `admin/access-audit/`。所有读取按所有者与当前组织限定，响应带 `Cache-Control: no-store`。

## 设置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WORK_ENABLED` | `False` | Work 总开关 |
| `WORK_AGENT_ENABLED` | `False` | 云端办公 Agent |
| `WORK_AGENT_URL` / `WORK_AGENT_TOKEN` | 空 | Agent Gateway 地址与凭据 |
| `WORK_AGENT_MODEL` | `deepseek-flash` | Agent 模型 |
| `WORK_AGENT_TOKEN_BUDGET` | `80000` | 单次运行预留上限（代码封顶 80000） |
| `WORK_AGENT_TIMEOUT` / `WORK_AGENT_MAX_CALLS` | `180` / `6` | 超时与模型调用上限 |
| `WORK_LOCAL_AGENT_ENABLED` | `False` | 本机协调 |
| `WORK_REMOTE_AGENT_ENABLED` | `False` | 允许远程派发到已登记工作空间 |
| `WORK_REVIEW_ENABLED` | `False` | Pi 只读复核 |
| `WORK_REVIEW_URL` / `WORK_REVIEW_TOKEN` | 空 | 复核 Gateway 地址与凭据 |
| `WORK_REVIEW_MODEL` / `WORK_REVIEW_TOKEN_BUDGET` | `deepseek-flash` / `20000` | 复核模型与单次预留 |
| `WORK_AGENT_ROLLOUT_MODE` | `closed` | `closed` / `allowlist` / `all` 账号灰度 |
| `WORK_AGENT_ALLOWED_USER_IDS` | 空 | `allowlist` 模式的账号 UUID 列表 |
| `WORK_TENANT_ACCESS_ENABLED` | `False` | 组织 entitlement / grant 准入 |
| `WORK_DAILY_TOKEN_BUDGET` / `WORK_MAX_OUTPUT_TOKENS` | `100000` / `3000` | 每日预算与输出上限 |

预算按“已预留 + 本次预留”计算；同一账号/组织的云端运行、本机登记任务与复核共享当日账本。

## 部署

1. `bash deploy/aliyun/enable-work.sh check` 只读检查迁移、开关、Agent/复核配置和 Work 队列消费者。
2. `bash deploy/aliyun/enable-work.sh on` 写入 `values.work.yaml`（`WORK_ENABLED=True`、启用 Work worker 与 Beat），复用当前不可变后端镜像发布，并复核消费者。
3. `bash deploy/aliyun/enable-work.sh off` 只关闭新写入，保留 worker 处理历史与过期设备。

Agent Gateway、本机运行时和复核部署分别使用 `values.work-agent.yaml.dist`、`values.work-review*.yaml.dist` 与 cohort 覆盖文件。所有开关默认关闭；开通顺序为 Gateway 可用、账号灰度、复核独立授权。

## 数据迁移

`0012_remove_materials_and_communication` 删除 `WorkMaterial`、`WorkTask.recipient/sources` 与 `WorkArtifactVersion.citations`，并把 `kind` 默认值改为 `office_agent`。该迁移不做数据回填；历史 `communication` 任务行保留在数据库中，但不会被新 API 展示或领取。前向升级与旧镜像写入兼容性的验证见 `work/tests/test_upgrade_compatibility.py`。

## 测试

在 `src/backend` 下运行定向套件（需要可用的 PostgreSQL、Redis 与 Test 配置环境变量）：

```bash
python -m pytest work/tests -q -o addopts="-q --import-mode=importlib"
```

真实本机联合验收需显式设置 `WORK_COORDINATION_LIVE_KEY_FILE` 与 `WE_MEET_LOCAL_ADAPTER`，测试启动仅监听 loopback 的真实 Django API 桥、实际 Node 协调器、dsh 与模型；默认跳过。真实 Pi 复核需 `WORK_AGENT_PI_TEST_IMAGE`。所有付费调用均为显式 opt-in，不自动重试。
