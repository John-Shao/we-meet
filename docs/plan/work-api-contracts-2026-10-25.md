# Work API 与内部契约草案（§22.2-2）

> 状态：契约草案，未生成生产客户端、未接入现有实现、未完成协议评审。
>
> 日期：2026-10-25
>
> 需求基线：[Work 系统架构 v2.9](work-system-architecture-2026-10-25.md) §11–§15、§21.2；[领域模型 DDL 草案](work-data-model-ddl-draft-2026-10-25.md)。
>
> 契约资产目录：[assets/work-contracts-2026-10-25](assets/work-contracts-2026-10-25/README.md)。

## 1. 范围与非目标

本批交付把架构中的用户/管理 API、内部领域命令、设备协议、事件和模型/工具出口落成可审阅的 schema：

- OpenAPI 3.1 用户/管理/operator API；
- 内部 Protobuf：control、device、events、egress；
- TaskEvent 的 JSON Schema；
- 契约级幂等、revision、错误码、permission_mode、版本规则与边界说明。

非目标：不实现鉴权服务器、不实现连接器适配器、不生成并提交客户端 SDK、不替换现有仓库接口、不证明供应商协议兼容、不做性能/安全压测。OpenAPI 中的服务地址、示例和 header 都是目标草案，不是部署事实。

## 2. 契约文件

| 文件 | 用途 |
|---|---|
| [openapi/work-openapi-v1.yaml](assets/work-contracts-2026-10-25/openapi/work-openapi-v1.yaml) | OpenAPI 3.1：bootstrap、预览/提交、Task/Run、审批、成果/采纳、SSE、inbox、连接器、设备、能力、管理端、operator |
| [proto/work/common/v1/common.proto](assets/work-contracts-2026-10-25/proto/work/common/v1/common.proto) | 共享枚举、OrgContext、Ref、Money/Usage/Error、Quiescence、事件信封 |
| [proto/work/control/v1/control.proto](assets/work-contracts-2026-10-25/proto/work/control/v1/control.proto) | 控制面领域命令：CreateRun、FinishRun、CreateOperation、ClaimDispatch、审批、预算、采纳、成果 finalize |
| [proto/work/device/v1/device.proto](assets/work-contracts-2026-10-25/proto/work/device/v1/device.proto) | 设备双向连接、lease/command/receipt/cancel/reconcile/journal_release |
| [proto/work/events/v1/events.proto](assets/work-contracts-2026-10-25/proto/work/events/v1/events.proto) | TaskEvent、InboxEvent、OutboxEnvelope 与类型化 payload |
| [proto/work/egress/v1/egress.proto](assets/work-contracts-2026-10-25/proto/work/egress/v1/egress.proto) | 模型/工具出口、usage、provider 查询与 unknown 核对 |
| [schema/work-event-envelope-v1.schema.json](assets/work-contracts-2026-10-25/schema/work-event-envelope-v1.schema.json) | SSE/inbox 公开事件信封 JSON Schema |

## 3. 全局规则

### 3.1 身份、组织与内部身份

- 用户/管理 API 的租户由会话绑定；请求体/URL 不接受可信 `org_id`。`operator` 路径中的 `orgId` 只作目标定位，仍需 operator 权限和审计。
- 内部 Protobuf 的 `OrgContext` 由认证层注入，不能由 Runtime、设备或模型提交。服务间调用必须使用受信工作负载身份、audience 和短生命周期；本契约只定义字段，不定义具体 IAM 实现。
- 模型/工具出口只在 Gateway 安全域注入供应商 Key；Runtime/Broker 不持长期 Key，也不在 event/trace 中记录 Key。

### 3.2 幂等与 revision

- 用户写接口幂等键唯一为请求体 `client_request_id`，作用域 `(org_id, subject_id, operation_type)`；不另设 `Idempotency-Key`。同 key 同 payload 返回原结果，同 key 不同 payload 返回 `409 idempotency_conflict`。
- 内部命令使用 `request_id` 标识命令；`CreateRun`/`CreateOperation` 由领域键与 request hash 幂等，预算结算由 `settlement_revision` 幂等。
- 状态变更使用 Task revision、Approval revision 或 `If-Match`；冲突返回 `409` 和当前 revision，不能最后写入覆盖。
- `202` 只表示持久受理，不表示模型已开始、外呼已发生或已计费。

### 3.3 错误与恢复

`ErrorResponse` 固定 `code`、`message`、`retryable`、`correlation_id`、`current_revision`、`recovery_action`。关键错误码：

`scope_unavailable`、`preview_stale`、`policy_changed`、`permission_mode_unavailable`、`approval_expired`、`budget_exhausted`、`device_offline`、`execution_unknown`、`run_not_quiescent`、`version_conflict`、`content_local_only`、`protocol_unsupported`、`resync_required`、`service_degraded`。

`retryable=true` 只表示可安全重发同一请求/查询，不表示外部副作用可以重放；unknown 操作必须先对账。

### 3.4 审批模式

`permission_mode` 唯一值：

- `ask_each`：默认；有数据访问/副作用的动作逐次审批。
- `auto_readonly`：当前 Task 的本地读取/只读命令/任务授权内连接器读取自动；写入、外部副作用、分享仍逐次审批；Task 终态失效。
- `plan_then_run`：只有计划能力可用时出现；计划批准只覆盖该 PlanVersion 的只读步骤，任何写入仍逐次审批。

模式在 Task 提交时固定；组织策略只能收紧。自动批准仍必须创建 Operation 与审计，不能成为匿名 allow-all。`bootstrap` 返回允许模式，预览返回生效模式；预览后策略变化返回 `preview_stale`。

### 3.5 任务静止、派发与采纳

- `Task.active_run_id` 只指向非终态 Run；`latest_run_id` 保留最近 Run。
- 阻塞 Operation：`prepared/waiting_approval/authorized/dispatching/unknown/unresolved`。新 Run 与采纳都要求无阻塞 Operation；`unresolved` 不自动放行。
- 派发必须同时满足：Run=`active`、Task=`open`、active_run 匹配、fence 匹配、Operation=`authorized` 且未被消费；CAS 胜出者才能发送。
- 采纳要求：Task revision 匹配、active_run 为空、latest Run 已终态、无阻塞 Operation、成果已发布且属于该 Task。
- 取消/停止只表示停止请求或已观察停止；不能把 token 流中断、socket 断开或进程退出当作外部副作用已回滚。

### 3.6 预算账目

- 同一 Operation 同时最多一个 `held/unknown` 预留；审批等待释放后用新的 `reservation_seq` 重预留。
- 结算按 `(operation_id, settlement_revision)` 唯一；同 revision 同金额幂等，不同金额冲突；修正追加 `adjust`，不覆写历史。
- 金额使用整数最小计费单位 + 币种 + price_version；usage 原始计量单独记录，不能用浮点累计。

### 3.7 内容与事件

- Event/payload 只带 ID、公开事实和 `content_ref`；禁止原始 reasoning、目录绝对路径、凭据和完整提示词。
- SSE 使用 `event_id` 去重、`Last-Event-ID` 续接；超出保留窗口返回 `resync_required`，客户端重取 Task 快照。
- 增量模型文本只来自公开回答通道；最终文本以 ArtifactVersion 为准，丢 chunk 不影响审批、计费、终态或成果。

## 4. API 面

OpenAPI 草案覆盖 30 个路径，按组：

| 组 | 代表接口 |
|---|---|
| Session | `GET /work/v1/bootstrap` |
| Tasks | `POST /task-previews`、`POST /tasks`、`GET /tasks`、`GET /tasks/{id}` |
| Runs | `POST /tasks/{id}/runs`、`GET /runs/{id}`、`POST /runs/{id}/cancel`、`GET /runs/{id}/operations` |
| Approvals | `GET /approvals`、`POST /approvals/{id}/decisions` |
| Artifacts | 上传会话、`POST /artifacts/{id}/versions`、`POST /tasks/{id}/acceptances` |
| Events | `GET /tasks/{id}/events`、`GET /inbox`、`GET /inbox/events` |
| Connectors | `GET/POST /connector-connections`、`POST /connector-grants/{id}/revoke` |
| Devices | `GET /devices`、`POST /devices/pairings` |
| Capabilities | `GET /capabilities` |
| Admin | overview、seats、budgets、policies、audit-exports（`If-Match` CAS） |
| Operator | `POST /operator/organizations/{orgId}/suspend`、`/resume` |

## 5. 内部 Protobuf

- **Control**：CreateRun/FinishRun/CreateOperation/ClaimDispatch 用 Task → Run → Operation 锁顺序；ClaimDispatch 返回 `dispatch_attempt_id` 与签名 permit，空值表示 CAS 未胜出。预算、审批、采纳、finalize 各有独立命令；不得用一个万能 update 绕过领域命令。
- **Device**：单个外向连接；Hello 绑定 device/session/boot/protocol；Command 带 operation/fence/hash/permit/seq；Receipt 按 seq 重传；`journal_release` 只能在回执、计量、去重达到部署持久性边界后发送；unknown 不释放 journal。
- **Events**：TaskEvent 使用每 Task 单调 `aggregate_seq`；InboxEvent 使用独立 cursor；OutboxEnvelope 只带公开 payload 与 `content_ref`。未知 schema version 影响权限/输出时拒绝执行，不忽略未知字段后降级。
- **Egress**：模型/工具请求绑定 Operation/fence/request hash；`body` 可能含用户内容，禁止普通日志；返回 usage、provider_request_id、unknown 状态；reasoning 只返回不透明引用，不转发原始链。

## 6. 版本规则

- 用户 API：`/work/v1`；不兼容变更升 major。响应事件带 `schema_version`，客户端不能理解影响权限/输出的版本时返回 `protocol_unsupported`。
- Protobuf：package 带 major（`v1`）；只做字段新增/保留 tag 的兼容变更；删除字段必须 `reserved`。设备协议另带 `major/minor/required_features/tool_manifest_hash`，握手协商。
- OpenAPI 只描述目标契约；生成客户端、mock server 与兼容性测试是后续实现工作，不能把 schema 通过校验当成端到端协议通过。

## 7. 验证记录

2026-10-25：

- OpenAPI 3.1 YAML 解析成功；30 个 path、64 个 schema；78 个本地 `$ref` 全部可解析；`openapi-spec-validator` 通过。
- 5 个 Protobuf 文件用 `grpc_tools.protoc` 编译通过（含 common/control/device/events/egress 与 well-known types），生成 descriptor set 仅用于本地验证，未提交。
- 事件 JSON Schema 解析通过（draft 2020-12）。
- 未执行：生成客户端/mock server 的编译、真实鉴权、SSE/WebSocket 连接测试、OAuth 回调、供应商协议回归、schema 兼容性矩阵、性能和安全模糊测试。

## 8. 待决问题

1. 用户会话是 cookie 还是 bearer，以及 SSE 的短期票据如何签发；当前 OpenAPI 同时声明两种安全方案。
2. `POST /connector-connections` 的回调、PKCE state 绑定和 redirect allowlist 的具体字段。
3. 上传会话对 `local_only` 成果的替代流程（设备 receipt 与本地版本），当前只描述云端上传。
4. SSE 游标过期使用 `410 Gone` 还是 `409 resync_required`；当前示例为 409。
5. 内部 mTLS/工作负载身份、audience、token 轮换和重放防护的部署实现。
6. Protobuf tag/字段演进策略、生成代码目录和合同测试的 CI 位置。
7. `operator` 与服务方 break-glass 的审批/审计 UI 契约。
8. OpenAPI 生成客户端与现有仓库 SDK 的边界；本批不引入依赖。

## 9. 边界

本契约可用于评审、mock、代码生成试验和纵切拆解；不证明现有实现符合契约，不证明供应商、设备或部署可用，不替代 S1–S7 验证与真实用户测试。下一批应先做“云端任务→采纳”纵切，把 OpenAPI、Control proto 与 DDL 命令连起来，再扩展设备与连接器。
