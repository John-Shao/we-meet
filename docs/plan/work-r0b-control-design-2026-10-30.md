# Work R0b 控制面与治理详细设计

> 配套：[架构](work-r0b-architecture-2026-10-30.md)、[本机协议](work-r0b-device-design-2026-10-30.md)、[体验与验证](work-r0b-experience-validation-2026-10-30.md)。新表/函数/接口均是待实现的设计，不是现有接口清单；不修改 R0a 已签语义或已应用迁移。状态见 [项目文档](work-project.md)。

## 1. 契约、版本与通用规则

### 1.1 API 版本边界

R0b 使用 `/work/v2`，响应 `contract_version=work-r0b-1`。现有 `/work/v1` 的 R0a 形状不扩入 local/approval/governance 新枚举；v1仍可读取/操作原云端任务。两版本复用相同领域 ID/幂等账本，不复制 Task 或状态机；新前端读 v2 可同时查看 R0a 云任务及 R0b 本机任务。旧客户端查询本机资源返回 `409 client_upgrade_required`，不返回错误类型的DTO；v1列表仅列其可理解的云任务，更新提示来自桌面版本检查，不把本机任务伪装云端。

除§1.4明确隔离的device-recovery历史公钥通道外，所有客户端写请求均为 Cookie+Host session验真+CSRF、`client_request_id(UUID)`；去重作用域 `(org,subject,logical_command,request_id)` 不含 API版本，避免升级后重发产生新工作。同键同规范 payload返回原结果，不同payload 409。revision/epoch用正整数字符串；时间UTC RFC3339；对象 additionalProperties=false；请求内容 UTF-8。错误为 `code,message,retryable,correlation_id,current_revision?,recovery_action`，无路径/正文/密钥。

GET默认 no-store，页面路由不作授权。分页使用签名 keyset cursor（绑定subject/org/filter/sort），limit 1..100。跨组织/非owner资源返回404，权限不足403，过时preview/revision409，语义输入422，过大413，未满足profile/版本409，服务不可确认503。所有写操作的业务结果、审计与outbox同事务，不能成功返回后才补审计。

### 1.2 闭合 DTO

| DTO | 必填字段与约束 |
|---|---|
| BootstrapV2 | subject_id、org{id,name,role,work_seat}、permissions[]、can_delegate_work、phases[]、execution_profiles[]、allowed_permission_modes[]、limits_by_profile、csrf_token、contract_version；can_delegate_work只反映当前owner委派权，不授业务写权；治理身份无席位时成功，但执行profile为空 |
| ExecutionProfile | id、revision、content_hash、target_kind=cloud/local、platform、protocol_major、required_features[]、runtime_digest、tool_manifest_hash、input_limits、output_limits、model_profile_id/revision/hash；不可用返回reason，不谎报为enabled；bootstrap给出精确版本，GET不可变版本返回同hash |
| LocalTargetSelection | kind=local、profile_id/revision/hash、device_id、session_id、workspace_grant_ids[1..4]及各revision；用于预览，不含local_intent，owner/org由服务端填 |
| InputV2 | 判别联合 kind=cloud/local；cloud含profile_id、goal、background、output_requirements；local含profile_id/revision/hash、device_id/session_id、local_input_ref、input_hash、component_scalar_counts、body_bytes、device_signature；local请求禁止goal/background/来源摘要正文 |
| PreviewV2 | preview_hash、expires_at、effective_mode、input_counts、token_upper_bound、output_location、grant revisions、model_destination、policy/access_epoch；hash覆盖以上所有执行边界 |
| ApprovalV2 | id、task/run/operation_id、params_hash、action_kind、risk、scope_summary、local_detail_ref、device_id、policy/access/grant revisions、expires_at、revision、status、allowed_decisions；无完整本地路径/参数 |
| GovernanceChange | change_id、kind、subject_ref、request_id、state=pending/applied/failed/reconcile、host_revision?、effective_revision、denial_active、current_revision、recovery_action |
| ArtifactVersionV2 | id/artifact/task/run、format、bytes/hash、version_no、source=run/user、location=local_only/cloud、device_id?、replicas[]、classification、published_at、content_available_here；正文访问另发ticket；run仅source=run时有值 |
| UserVersionProof | 设备签名，闭合字段 `v,org_id,subject_id,device_id,session_id,task_id,artifact_id,base_version_no,base_hash,version_id,format,content_hash,bytes,classification,client_request_id,nonce,expires_at`；有效期60s，nonce单次，不复用其他签名域 |

InputV2 的cloud分支沿用R0a Content Store；local分支的goal/background/交付要求、来源摘要、完整上下文及checkpoint均只存本机加密存储，控制面仅持不透明ref/hash/计数和用户认可的安全标题。GET本机Task也不解密或代理拉取这些正文；跨设备仅元数据。预览计数由Broker在规范化后计算并签署，绑定profile/session/input_hash；API拒绝local请求中任何正文字段，不能凭renderer计数放行。用户明确批准某次远程模型请求时允许其bytes经egress流转，不意味着授权云端持久保存输入。

### 1.3 预览与提交的闭合请求

LocalInputProof签名覆盖 `v,org_id,subject_id,device_id,session_id,local_input_ref,input_hash,profile_id,profile_revision,profile_hash,component_scalar_counts,body_bytes,nonce,expires_at`；计数分量固定goal/background/template_instructions/output_requirements/source_summary，且总量≤8000。nonce仅认证该输入证据，不代替提交intent。CloudInput不接受任何device proof；LocalInput禁止任何正文。

`PreviewRequest={client_request_id,input_id,target_selection,template_id,template_version,permission_mode,output_format}`。local target_selection即LocalTargetSelection，input_id指已登记的LocalInputProof；此阶段不要求local_intent。服务端签定PreviewV2，expiry=120s；绑定input_hash、target_selection规范hash、profile、template、mode、output、model route以及当前epoch。

`SubmitRequest={client_request_id,input_id,preview_hash,target_selection,local_intent}`。cloud的local_intent必须null；local intent在用户看到已有Preview后才由Broker生成，签名绑定request_id、preview_hash、input_hash、target_selection_hash、全部grant revision、profile hash、owner/org/session和60s nonce。提交事务比较三个hash与已签preview相等、复验当前epoch，再写跨Task去重记录并消费intent nonce。同键重放先查已受理结果，不重新消费；preview过期/参数变化返回preview_stale，不默默重算后发送。

### 1.4 端点总表

所有下列相对路径均在 `/work/v2`；变量ID必须经同租户关联查询。

| 方法/路径 | 输入 / 返回 | 权限与领域命令 |
|---|---|---|
| GET /bootstrap | BootstrapV2 | 有效身份；执行/治理分别求值 |
| POST /inputs、POST /task-previews、POST /tasks | InputV2/选择意图/preview_hash；201 ref /200 Preview/202 task+run | 执行席位；local提交另验local_intent |
| GET /tasks、GET /tasks/{id}、GET /tasks/{id}/events | 分页/详情/SSE | owner；v2扩等待原因，不透传本机正文 |
| POST /tasks/{id}/runs、POST /runs/{id}/cancel | snapshot/revision / revision；202 run | owner；静止门槛与原Run对账；本机重试新intent |
| POST /devices/pairings、POST /devices/pairings/{id}/confirm | 本机 §2 DTO；201 challenge /200 device+cert | 当前本机owner会话；单次challenge |
| POST /devices/{id}/session-tickets、POST /devices/{id}/certificate-renewals | request_id+pubkey签名；201 ticket/certificate | owner+active设备，不接受换key续期 |
| POST /device-recovery/challenges、POST /device-recovery/sessions | 历史device/journal/dispatch proof；60s challenge /5min recovery session | 独立历史公钥证明，非Host用户会话；只核对已登记Operation，不授执行或读取权 |
| GET /devices、POST /devices/{id}/revoke | 设备摘要 / revision；200或202 change | owner；revoke不要求执行席位 |
| GET/POST /workspace-grants、POST /workspace-grants/{id}/revoke | 设备签定root_ref/root_identity_hash/classification/tools/revision；201 grant | owner+当前设备session；revoke可先本地停止 |
| POST /runs/{id}/workspace-rebinds | client_request_id、old_grant_id、new_grant_id、GrantSuccessionProof；202 新binding_revision | owner+当前设备session；Run处于waiting(input)且引用old_grant；两个grant的root_identity_hash相等、同device/owner；不同目录返回`workspace_identity_changed`，命令见§4.2 |
| GET /approvals、GET /approvals/{id} | pending过滤 / ApprovalV2 | owner；本机详细参数只能本机ticket读取 |
| POST /approvals/{id}/decisions | request_id、expected_revision、params_hash、decision、remember_readonly?、local_proof；200决定 | owner且当前执行权；remember只能approved且只读 |
| POST /readonly-grants/{id}/revoke | revision+request_id；200 | owner；提升revision、取消未消费许可 |
| GET /artifacts/{id}/versions/{version} | ArtifactVersionV2 | 当前对象ACL，不要求预算/Run |
| POST /artifacts/{id}/versions/{version}/read-tickets | request_id、device_session；201 60s票据 | 本机owner，org/subject/version绑定 |
| POST /artifacts/{id}/versions | kind=local、client_request_id、base_version_no、format/content_hash/bytes、version_id、user_version_proof；201 ArtifactVersionV2+服务端签名publish_ack | owner+当前执行席位+原设备proof+Run静止；无Operation/permit/审批行/配额，命令见§7.1。R0b只开放kind=local；kind=cloud返回422，云端任务保持R0a现状（`create_user_artifact_version`当前无HTTP调用方） |
| POST /tasks/{id}/acceptances | revision、version_id或reason、本机possession proof；200 | 静止+owner+具体版本，不能仅客户端标completed |
| GET /tasks/{id}/artifact-recoveries、POST /artifact-recoveries/{id}/restore | 元数据 / request_id+task_revision+possession proof；200恢复版本 | 当前owner、同原设备；原Run仍latest/未取消/无后继/全部核账才发布，否则只读恢复对象 |
| POST /artifact-recoveries/{id}/read-tickets | request_id+device_session+possession proof；60s票据 | 当前owner/ACL且未删除；本机只读/显式导出，不给recovery-only设备身份 |
| POST /artifacts/{id}/versions/{version}/syncs | request_id、revision、disclosure_hash、local proof；201 upload_session | owner+当前同步策略，非管理员代同步 |
| POST /content-uploads/{id}/chunk-permits | request_id、offset、length≤65536、chunk_hash；201 ContentTransferPermit | 当前owner/ACL/披露/policy epoch复验后原子消费该chunk授权，不要求active Run |
| PUT /content-uploads/{id}/body、POST /content-uploads/{id}/finalize、DELETE /content-uploads/{id} | chunk bytes+Content-Range / hash+request_id /request_id；204/200 replica/202 cleanup | PUT需5s独立transfer permit且先验再收正文；同offset只能同hash，finalize二次复验 |
| GET /admin/overview、GET /admin/seats | 元数据/席位列表与seat_limit | overview按对应seat/quota/usage/audit读权返回获权区块，无权区块不返回；seats需seat.read，不含成员正文 |
| GET /admin/delegations、POST /admin/delegations、POST /admin/delegations/{id}/revoke | assignment_id、target_subject_id、permissions[]、expected_revision、request_id；202 GovernanceChange | 当前组织owner及写时10min内重新认证，通过Host ChangeAssignment；不用旧AdminRole，无Work执行seat也可用 |
| POST /admin/seat-changes、GET /admin/changes/{id} | member+desired+revision+request_id / change | seat.write提交；seat change按seat.read或当前seat.write+本人创建查询；delegation change由当前org owner查询；其他kind按对应当前治理权，均只返回该change最小结果，不连带席位列表 |
| GET /admin/seat-candidates | 查询现有active成员的安全别名/subject_id，limit≤20 | seat.write；只用于授撤目标选择，不返回成员敏感字段或席位汇总 |
| GET/PATCH /admin/quota-policy | token阈值/Run上限+revision | quota.read/write；不能设置金额或改客户hard模式 |
| GET/PATCH /admin/local-policy | local allowed/tools/classifications/destinations/readonly/limits+revision | policy.read/write，只可收紧平台上界 |
| GET /usage/me、GET /admin/usage | 按日provider/model分列 | 本人 / usage.read，参考非账单 |
| GET /admin/audit-events、POST /admin/audit-exports、GET /admin/audit-exports/{id} | cursor/作业范围/revision | audit.read/export分开 |
| POST /admin/audit-exports/{id}/download-tokens、GET /admin/audit-exports/{id}/content | request_id / X-Download-Token；一次性兑换 | export权限每次复验；不在URL放token |
| POST /operator/organizations/{id}/execution-state | state、seat_limit、expected_revision、ticket_id、request_id；202 | 独立operator身份，非客户治理权限 |

未列出的suite/connector/plan/remote参数即使客户端传入也422拒绝。本期不增加移动审批专用端点；本机审批需要同设备local_proof，手机无法构造。

设备专用模型入口 `POST /device/v1/model/invoke` 不属于 `/work/v2`，也不用 Cookie：独立 ingress、只信任设备 CA、凭 `aud=device-egress` 许可调用，合同见本机 §5.3。

## 2. 治理权限与委派

### 2.1 细分权限

用户已选细分可委派模式。以下是新增登记码，不复活已删除的 `org.work_grant.write`，也不套用与meet模型混用的 `org.ai_quota.write`：

| 权限 | 允许 | 不允许 |
|---|---|---|
| org.work.seat.read / write | 席位元数据 / 给既有active成员授撤座 | 创建成员、修改角色、改变购买上限 |
| org.work.quota.read / write | 护栏 / 修改token阈值和Run上限 | 金额计费、放宽平台硬上限、改演示hard模式 |
| org.work.policy.read / write | 查看 / 收紧本机工具/外发/readonly策略 | 开放未实现工具、读成员正文、写model credentials |
| org.work.usage.read | 组织按用户/provider/model token聚合 | 模型内容或供应商完整账单 |
| org.work.audit.read / export | 查元数据 / 异步导出 | 包含本机路径、正文、凭证 |

这些权限全为组织范围，拒绝department scope；不默认预置到hr/it/admin_office或admin通配规则。组织owner可以显式委派或给自己授予；`org.role.write` 本身不能让普通admin自动授予新Work权限。

**隔离Work委派域，不修改旧部门scope的合并语义**：Host新增 `WorkGovernanceAssignment(org_id,user_id,permissions[],revision,status,granted_by)`，按 §2.3 绑定组织内的一个人（不绑定某条部门 Membership，部门调整不影响委派），不创建第二套身份/组织或Work侧角色真相。新码登记在独立 `WORK_GOVERNANCE_PERMISSIONS` 目录，不能加入旧 `ALL_PERMISSIONS`，旧 `AdminRole/AdminRoleAssignment` 创建/改权/复制/分配/导入一律拒绝这些码（包括owner请求）。Work委派只能由owner专用入口操作，直接给成员精确permission set，不复用role_id。读取Work AccessProof只看该独立域，旧admin通配不等于Work权限；旧 `get_admin_context` 永不读取Work assignment，避免其“任一ALL assignment扩大全部权限scope”的现有算法把部门HR权扩成全组织。普通组织owner身份只提供委派管理权，业务治理写仍需显式assignment。

专用委派创建/修改/撤销/批量（本期不提供批量UI）均校验owner、10min近期认证、revision并强审计；Work UI通过Host端口调用同一权威流程。验收必须对“部门HR权限+组织级Work席位权”的组合验证两个域各自scope不变；不能以只测试Work接口代替旧部门权限回归。

owner-only模型接入配置继续按D-08执行，不被任何委派码覆盖。客户治理写权不等于组织服务方开通权；operator_suspended优先，任何seat/policy写都不能解除。无执行席位的有权治理者应可打开管理面；普通有seat用户不能打开管理面。`bootstrap.load`必须拆分“有效身份”和“执行seat”检查，不能沿用现行无seat即bootstrap403。

### 2.2 Host AccessProof v3

新增 Host 端口 `ResolveWorkAccess(subject/session, org)` 返回闭合对象：`subject_id, org_id, member_status, org_status, work_seat, member_revision, org_revision, work_permissions[], permissions_revision, session_revision, authenticated_at, verified_at, expires_at`。member_status/work_seat/member_revision 均取自 §2.3 的归并结果，不取某一条 Membership。mTLS验真沿用现有Host边界，但新字段/新写路径独立复核。权限计算只能来自Host权威成员/委派记录，role字符串不是权限列表。

每次治理写、审批、执行许可消费都重取当前proof，不复用bootstrap权限。proof TTL上限30s；敏感委派/模型接入改动还要authenticated_at≤10min，不满足走Host重新认证，不以登录cookie签发时间冒充。控制面事务检查proof revision与已观察目录/deny epoch，不持锁等Host网络。外部Host撤权与Work提交无法跨库原子化：Work内撤权在本地deny提交后立即阻止新许可；Host外部离职通过事件/最多30s重新验证收窄，已签5s动作许可可能在途，UI不得承诺全链路零延迟。TTL/网络失败时 fail-closed。

本机审批决定包含同设备签名proof，治理操作不要求该设备证明。权限撤销后历史治理写重放只返回可见结果或403，不重新执行。

### 2.3 一人多条 Membership 的归并

Host 允许同一用户在一个组织里按部门有多条 Membership（`meet_membership` 只约束 user+department 唯一、每组织一条 primary），而 `work_seat` 目前存在每一条 Membership 上，Work 目录列表也逐条输出（`src/backend/core/api/work_host.py` 的 `WorkHostMemberListView`）。Work 同步再逐条写进按 `(org_id, subject_id)` 唯一的投影，结果由最后修改的那条行决定：例如一人两个部门，A 部门行有席位、B 部门行刚改了职务，席位就会被 B 行覆盖成 false；某个兼任部门行改为 left 也会让整个人失去执行权。R0b 的席位、委派和 AccessProof 都按 subject 定位，必须先有确定的“一人一份”状态。

**Host 侧唯一权威行**：新增 `WorkMemberState(org_id, user_id, work_seat, directory_revision)`，`(org_id, user_id)` 唯一。

- 席位只存在这一行；`Membership.work_seat` 迁移后删除。迁移规则：同一人任一 active 行有席位即授予（这是管理员的显式动作），各行取值不一致的人列入迁移报告交组织 owner 复核；迁移后若超出 seat_limit，按 §3.1 标 overallocated，不随机撤人。
- `directory_revision` 取组织的同一目录序列。该用户任一 Membership 新增、修改、删除或调动组织，以及本行自身变化，都要同事务推进这一行的 revision；否则删掉一条兼任行时，剩余行的 revision 可能低于增量水位，同步会漏掉这次变化。
- `WorkGovernanceAssignment` 也按 `(org_id, user_id)` 定位。

**归并规则**（Host 列表、ResolveWorkAccess、ChangeSeat、委派校验共用同一函数，不在 Work 侧重算）：

| 字段 | 规则 |
|---|---|
| subject_id | `user.sub`，校验同现状 |
| status | User 已停用且有 active 行时为 suspended；否则任一行 active 为 active；否则有 suspended 为 suspended；否则有 invited 为 invited；否则为 left（含已无任何行） |
| role | 只看 active 行，按 owner > admin > member 取最高；与 Host 现有 `is_caller_org_admin`“任一 active 行即算管理员”的口径一致（`src/backend/core/api/directory.py`）。无 active 行时为 member |
| work_seat | 取 WorkMemberState；执行仍要求 status=active |
| revision | WorkMemberState.directory_revision |

**状态变为 left 的后果**：Host 在同一事务里清除该人的席位并撤销其 WorkGovernanceAssignment，写审计与 outbox。离开组织的人不应继续占用付费席位或保留治理权；之后再入职需要重新授座和委派。suspended 不清除，只是暂时不可用。

**Work 侧**：目录列表改为每个 subject 一项、按 user 分页，响应形状不变，`sync_member_projection` 签名不变。Work 同步把同一次列表中重复出现的 subject 视为 `directory_protocol_invalid` 并保留旧水位（现有 `sync.go` 只按 subject 去重收集 present，不报错），防止归并缺陷再次被静默覆盖。R0a 投影同样受此缺陷影响，这项修正同时适用于现有 Host 目录列表，不另开兼容路径。本期不支持一人跨多个组织（P1-A 已定），归并只在单个组织内进行。

## 3. 席位权威写入与组织开停

### 3.1 Host 新增写端口

Work Core依赖 `SeatAdministration.ChangeSeat`、`GetSeatChange`、`GovernanceDelegation.ChangeAssignment`，由WeMeet adapter实现。拟定Host wire前缀 `/work-host/v3`，仅专用Work治理工作负载mTLS可调用；设备证书/egress身份拒绝。

`ChangeSeat` 输入：`command_id(UUID), org_id, target_subject_id, desired(bool), expected_member_revision, actor_session_proof, reason_code, payload_hash`。Host重新验证actor当前seat.write、target 归并状态为 active 且同org；desired=true还检查商业seat_limit和Host组织执行上界，单org锁内计数（按 WorkMemberState 中 work_seat=true 的人数，不按 Membership 行数）并锁该人的 WorkMemberState 行，写work_seat+member revision+command dedup+Host audit+outbox。返回 `command_id,status,member_revision,org_revision,work_seat,payload_hash`。同command不同payload409；超时GET查询原command，不生成新命令。GET not_found不证明请求未在网络中，只允许重发同一command_id。Host不写Work表。

`GovernanceDelegation.ChangeAssignment/GetCommand`（Host `POST /work-governance-commands`、`GET /work-governance-commands/{command_id}`）输入 `command_id,org_id,target_subject_id,assignment_id?,permissions[],desired_status,expected_assignment_revision,payload_hash,actor_session_proof`；只写WorkGovernanceAssignment，owner-only，不接受role_id、department scope或未知权限码。Host同事务写assignment+command去重+权限revision+audit/outbox；返回command_id/payload_hash/assignment_revision/permissions_revision/status。同command异payload409；响应丢失由Work worker使用同command查询，not_found只允许原key重发。结果GET不要求seat.read，而须当前owner和同org；旧owner失权后不能读取。Work对账器用限定工作负载身份查原已登记命令，不能新建或改写委派。事件引发Work AccessProof失效和下一动作复验。

`ExecutionEntitlement.Apply/GetCommand`（Host `POST /organizations/{org}/work-entitlement-commands`、`GET /work-entitlement-commands/{command_id}`）输入 `command_id,org_id,expected_entitlement_revision,target_entitlement_revision,enabled,seat_limit,operator_suspended,operator_authorization_ref,payload_hash`。仅专用operator-adapter身份可调用，Host核验授权引用/目标组织，普通Work seat.write工作负载拒绝。Host与ChangeSeat共用组织行锁，单事务写entitlement+command去重+审计；返回applied revision/payload_hash/occupied_seats。同command异payload冲突；目标revision必须单调。降seat_limit低于occupied不随机撤现有席位，标overallocated并阻止新授座；停用则立即阻止Host新的授座并发收窄事件。Work在收到同payload/target_revision的权威回执后才标host_ack_revision；网络超时查询原command，不能将发包成功当ACK。

### 3.2 Work saga 与双写边界

1. API验真/读当前proof，创建 `governance_change`、本地审计/outbox，返回202 pending。撤座同事务先建立 `access_restriction`、提升access_epoch、写cancel_intent；即使Host不可用也不能继续新动作。
2. worker调用Host同一command；不持数据库锁等网络。Host成功回执后，目录角色按单调revision更新投影，再标change applied。授座在观察到Host成功且当前entitlement/deny允许前不生效。
3. Host超时转reconcile，以command_id查询/重发；grant失败不产生任何本地seat，revoke失败保留本地deny，UI显示“本地已停止授权，席位同步待核对”，不能假toast“撤销全部完成”。
4. 旧同步不能消除 deny。Work 发起的撤座 deny 只能由 Host 之后的一次**授座命令**解除：该命令的 member_revision 必须高于撤座回执的 revision。命令来自 Work 的显式重新授座（绑定当前 restriction_revision）或 Host 原生页面都可以，因为所有授座入口都走同一个 Host ChangeSeat（见下段）；Work 通过 outbox 事件中的 command_id 和 revision 识别它，而不是凭投影里 work_seat 变成 true。普通member sync只收窄不扩权；其他org/grant/version deny不受影响，规则汇总见 §3.4。
5. 同member并发授撤操作按change revision串行，禁止有未决change时反向覆盖。worker失败可重试同id；后台仅操作该change，不拥有任意org写权。

所有席位写入入口（Host原生页面/批量/运营）必须调用相同Host领域规则和seat_limit锁；不能让旧成员PATCH直接赋work_seat绕过。商业seat_limit是明确entitlement，不是成员总数；未配置上限或执行开通时返回 `entitlement_incomplete`，不猜套餐/无限席位。

### 3.3 服务方开通/停用

服务方独立operator身份+允许管理组织集合+工单，写Work `execution_entitlement(enabled,seat_limit,revision,operator_suspended)`；seat_limit通过Host合同同步到席位权威后才允许新授座。Host组织不存在/已归档不创建组织、更不创建用户。开通返回pending直至Host确认上界revision；停用先本地deny+cancel再同步Host。恢复只解除特定operator_suspended，不恢复已撤成员/目录许可/旧run，也不重放Operation。历史audit/content读取按独立ACL裁定。Host 侧组织停用/归档与 Work 侧 operator_suspended 是两件独立的事，各自的 deny 分别解除，见 §3.4。

### 3.4 deny 的来源与解除

原设计只写了“普通 sync 只收窄不扩权”和两类显式解除（重新授座、operator 恢复）。Host 服务方执行 `activate()`/`restore()`（`src/backend/core/services/organization_lifecycle.py`，仅服务方可用）或成员恢复 active 后，同步造成的 deny 没有任何解除路径，组织或成员会被永久挡住。现按来源分类，每条 `access_restriction` 必须记录来源，并且只能按自己来源的规则解除：

| source | 建立时机 | 解除条件 | 解除者 |
|---|---|---|---|
| host_org | 同步观察到组织 status 变为 suspended/archived | 同步观察到 status=active，且该 org revision 高于建立时记录的 `host_revision` | `apply_directory_recovery` |
| host_member | 同步观察到该人归并 status 离开 active（suspended/left） | 同步观察到归并 status=active，且 member revision 高于 `host_revision` | `apply_directory_recovery` |
| host_seat | 同步观察到席位由 true 变为 false，而 Work 没有对应撤座 change | 观察到一条 Host 授座命令事件，member_revision 高于 `host_revision` | `apply_directory_recovery` |
| work_seat_change | Work 撤座 saga 第 1 步 | §3.2 第 4 条 | `apply_host_result` |
| operator | operator 停用 | operator 恢复 operator_suspended | operator 命令 |
| governance / policy / device / grant / model | 委派撤销、策略收窄、设备或目录撤销、模型 profile 撤销 | 不解除；之后新的授予产生新 revision，旧 deny 只覆盖旧 epoch | 无 |

规则：

1. **只有 Host 权威的、更高 revision 的正向变化才能解除 host_* deny。** 同步是单调的（`sync_*_projection` 拒绝不高于当前值的 revision），迟到或重放的旧快照不可能带来更高 revision，所以不会把已撤权的人复活。org 的“恢复”只能是服务方在 Host 的生命周期操作，组织 owner 或任何 Work 治理权限都不能触发。
2. **解除只针对该条 deny。** 组织恢复不解除成员级、席位级或 Work 发起的 deny：停用期间离职的人、被撤座的人仍保持各自的 deny；operator_suspended 也照旧生效。实际执行权仍是 §3 不变量 1 的交集。
3. **解除不复活任何旧东西。** 被取消的 Run 不恢复，旧 workspace grant、只读允许、审批、device session 和 lease 都因 epoch 提升而失效；设备须重新 hello 换新 session。解除只让**之后**的新会话、新 Run 和新许可可以通过检查，新 Run 的 admission_access_epoch 更高，迟到的旧 hint 不会误伤（§6.1）。
4. **archived 恢复同样适用**，因为 Host `restore()` 会把组织置回 active；但 Work 在归档期间按保留政策已清理的数据不恢复，界面要说明。
5. **同一人同时有多条 host_* deny**（例如组织停用期间本人也被停用），必须各自满足条件才放开；任一未满足就继续拒绝。
6. `apply_directory_recovery` 在 `sync_org_projection`/`sync_member_projection` 同事务内由同步写者调用，只能把 host_* deny 置为 released 并写审计/outbox，不能创建授予，也不能触碰其他来源的 deny。

## 4. 数据结构、领域命令与事务

### 4.1 PostgreSQL 增量

租户表均含org_id、created_at/updated_at、revision；UUID随机；复合FK必须带org_id。新增表非owner运行角色、FORCE RLS、无直接INSERT/UPDATE/DELETE；领域函数固定search_path、校验可信subject/org/调用角色，审计/outbox同事务。下面为逻辑DDL规范，实施时转换migration并新增catalog/冒烟，不将早期全量DDL覆到现库。

| 表 | 主键/关键字段 | 约束/索引 |
|---|---|---|
| device | `(org_id,id)`、owner、pubkey、cert serial、platform、status、revoked_at | 同组织owner索引；key不可原地换绑 |
| device_pairing | `(org_id,id)`、owner、session_revision、challenge_hash、pubkey_hash、expiry、consumed_at | challenge一次CAS；过期索引；无明文ticket |
| device_session | `(org_id,id)`、device/owner/boot/agent_instance、protocol/runtime/profile、generation、expiry、state | 每device仅一个active；失效旧session不删除证据 |
| workspace_grant | `(org_id,id)`、device/session/owner、root_ref、root_identity_hash、tools、classification、expiry、state、succeeded_by? | root_ref是随机UUID；root_identity_hash是设备密钥HMAC，仅比较相等；同org/device/session复合FK |
| workspace_grant_succession | `(org_id,run_id,old_grant_id)`、new_grant_id、proof_hash、binding_revision | 每Run每旧grant最多一条；两grant同device/owner且root_identity_hash相等 |
| execution_lease | `(org_id,id)`、run/device/session/fence/generation、expiry、last_receipt_seq、state | 每run一个active；fence单调，session改变使旧lease失效 |
| device_run_binding | `(org_id,run_id,binding_revision)`、input_ref/hash、snapshot/profile/tool/model版本、original_device、expected_checkpoint、start_nonce、state | start_nonce唯一；只能worker从提交记录派生，原Run恢复不新建Task |
| work_run_classification | `(org_id,task_id)`、task_kind=user_task/configuration_probe、probe_id? | kind由入口决定；普通任务API不可指定probe；统一账本、分别授权和列表过滤 |
| device_dispatch | `(org_id,operation_id,attempt_id)`、device/session/journal_epoch、command/permit_jti、hash、fence、expiry、execution_id?、delivery_state=not_applicable/pending/delivered/undelivered | command/jti唯一；Operation只能同目标取许可；只有device-egress许可有execution_id和非not_applicable的delivery_state |
| device_checkpoint | `(org_id,run_id,checkpoint_seq)`、binding_revision、fence、checkpoint_hash、local_ref、receipt_through_seq、pending_operation_set_hash、signed_payload_hash | 同seq异hash冲突；seq单调；只存hash/不透明ref；旧fence不推进恢复基线 |
| device_run_finish | `(org_id,run_id,finish_id)`、binding_revision、fence、outcome、reason、final_checkpoint、operation_set_hash、deliverables、signed_payload_hash、state、terminal_run_revision | 每Run最多一条accepted；同finish_id异payload冲突 |
| device_receipt | `(org_id,device_id,journal_epoch,seq)`、operation/attempt/hash/fence、state/outcome、signed_payload_hash、result_ref | 同seq不同payload冲突；operation final唯一，不接受started覆盖final |
| journal_release | `(org_id,device_id,journal_epoch,through_seq,generation)`、candidate_lsn、durable_proof_ref、release_state、signature | 连续watermark单调；unknown不可越过 |
| readonly_approval_grant | `(org_id,id)`、owner/run/device、workspace_grant/revision、tool_set/resource_selector_hash、policy_epoch、expiry、status | 最长24h且不跨Run终态；写/外发工具禁止 |
| governance_change | `(org_id,id)`、command_id、actor、target/kind、payload_hash、expected_revision、host_revision、state | `(org,actor,logical_command,client_request_id)`唯一；待处理索引 |
| access_restriction | `(org_id,id)`、subject/device/grant可选、scope、source（闭集见§3.4）、reason、epoch、host_revision?、source_change、state=active/released、released_by_revision? | 各scope deny可叠加；只能按自身source规则解除；host_*来源必须有host_revision |
| cancellation_intent | `(org_id,source_event_id,run_id)`、reason、state、next_attempt、attempts | 同源Run唯一；未送达索引 |
| execution_entitlement | org_id、enabled、seat_limit、operator_suspended、revision、host_ack_revision | seat_limit非负；未确认Host上界不增权 |
| artifact_replica | `(org_id,version_id,location,replica_id)`、device_id/content_ref、hash/bytes、state | 版本hash/bytes与原版一致，不能换内容 |
| content_upload | `(org_id,id)`、version/owner、hash/bytes/classification、disclosure_hash、expiry、state | 每session不可覆写不同bytes；只在finalized发布replica |
| content_transfer_chunk | `(org_id,upload_id,offset)`、length/hash、permit_jti、epoch、expiry、state | 同offset异hash拒绝；每次传输记录新许可，原chunk内容不可替换 |
| local_artifact_recovery | `(org_id,operation_id,version_id)`、device/original_run、manifest/hash/bytes、receipt_ref、state | 仅已核对success的原Operation；无直接发布权、正文仍本机 |

扩展run/snapshot关联 local target、输入/输出profile版本、设备/工具manifest和epoch；不把安全字段藏成无约束JSON。现有 `approval/approval_decision/approval_operation` 复用，但新增本机detail_ref、device签定hash和grant/policy/access revision，补当前epoch判断。现有quota/usage/outbox/task_event/acceptance表复用，不引入第二本预算账。

`artifact_version` 增量：`content_ref` 去 NOT NULL；新增 `location`（默认cloud）、`version_id`、`device_id`、`local_ref`、`classification`；CHECK 要求 location=cloud 时 content_ref 非空，location=local_only 时 content_ref 为空且其余四列非空。`artifact_version_immutable_content` 触发器扩到新列。R0a 读取路径（`readArtifactVersion` 等）必须先判 location，对 local_only 返回 `content_on_original_device`，不能把空 content_ref 交给 Content Store。已应用迁移不改，用新增量实现。

`operation` 增量（仅本机 Run 使用，云端 Run 留空）：新增 `step_key`、`supersede_no`（默认0）、`supersedes_operation_id`、`supersede_reason`；CHECK 要求 `logical_key = step_key || '#' || supersede_no`，取代字段要么全空要么全有；部分唯一索引 `(org_id, run_id, step_key)` WHERE state 不在终态集合，保证同一步骤最多一个未终结 Operation；`supersedes_operation_id` 唯一，一个 Operation 最多被取代一次。现有 `(org_id, run_id, logical_key)` 唯一键不变。

### 4.2 领域命令和写者

| 命令 | 调用者 | 原子写集/重放条件 |
|---|---|---|
| pair_device / activate_device_session / revoke_device | API/设备入口受限角色 | 设备/session/撤权+审计outbox；challenge/command去重 |
| register_workspace_grant / revoke_workspace_grant | API+当前设备证明 | grant+epoch+依赖Run取消意图；root变更新id |
| create_device_run_binding / acknowledge_run_ready | worker / gateway领域代理 | 从提交/已核对checkpoint构造offer并绑定版本；ready验设备签名，未ready不AcquireRun；重复ACK幂等 |
| acquire_device_lease / renew_device_lease | worker/gateway领域代理 | run/fence/session检查，lease CAS，记录start_nonce后签run_start，不创建工具/模型Operation |
| prepare_local_operation | worker（仅消费gateway验证后的action_prepare） | Operation+local action hash/ref；校验run/session/fence、checkpoint序号和工具manifest；同logical_key不同hash拒绝；回action_prepared，无正文上行；带supersedes时按本机§3.5校验：同Run同step_key、旧Operation的未执行证明（或resend_undelivered的undelivered）成立、supersede_no为旧值加一且≤5、action_kind/tool_schema/destination不变、classification不降、上界不升；reauthorized还要求旧grant在workspace_grant_succession中且新Action引用对应new_grant；新Operation的supersedes_operation_id唯一指向旧Operation，防止同一旧动作被取代两次。resend_undelivered强制人工审批 |
| rebind_run_workspace | work_api（POST /runs/{id}/workspace-rebinds） | 验proof签名/nonce/session、Run为waiting(input)且引用old_grant、两grant同device/owner/root_identity_hash；写succession、旧grant标succeeded_by、使旧grant上的readonly_approval_grant失效，并按§3.2创建更高binding_revision的resume offer；同request_id幂等 |
| request_approval | work_worker | prepared→waiting_approval、审批行、wait/outbox；不授权API随意发起 |
| decide_local_approval / revoke_readonly_grant | work_api | 当前epoch/owner/CAS、决定/readonly grant、Operation状态/outbox |
| consume_device_permit | 专用authz，不给renderer/Node | Task/Run/Operation+current access/grant/lease+approval+配额，单次dispatch CAS；org_remote模型动作同事务调用register_device_model_execution |
| register_device_model_execution | consume_device_permit内部 | 写mode=execute的runtime_execution：holder=`device:<device>:<session>`、intent_ref=`local:<operation_id>`（只满足既有约束，不解析正文）、intent_hash=request_hash、lease_until=permit到期；不写内容引用 |
| consume_device_model_gate | work_worker（egress设备入口经内部authz调用） | 复验device session/permit jti/当前access与policy epoch后调用既有consume_dispatch_by_execution，复用dispatch_delivery单赢家；不授予新DML |
| record_device_receipt | gateway经领域代理 | 验签/关联、receipt、Operation结果、task_event；旧fence仅核账。org_remote的usage/settlement只由egress receipt经finish_operation_from_receipt写入，此命令只比对gateway_receipt_hash并写delivery_state，不一致则隔离并转waiting(reconcile)；device_local/org_private经record_device_model_result写usage（source=device_adapter），因为既有函数的provider/usage_source枚举不覆盖本机模型 |
| resolve_undelivered_model_dispatch | worker | 按本机§5.3依gate事实裁决：无gate则seal_dispatch_not_sent后取消Operation并释放预留；consumed无receipt转unknown；success receipt写undelivered并转waiting(input)；迟到attach重新评估，同结论幂等 |
| record_device_checkpoint | gateway经领域代理（含action_prepare/run_finish内嵌） | 验签/fence/binding，单调写device_checkpoint；同seq异hash冲突并转waiting(reconcile)，停止新许可 |
| finish_local_run | gateway经领域代理 | 见§6.4；同事务写device_run_finish、finish_run、lease/binding收尾、event/outbox |
| create_local_user_artifact_version | work_api | 见§7.1；proof nonce、版本发布、任务revision、event、audit、去重同事务；不写Operation/quota，不要求active Run |
| create_journal_release / confirm_journal_release | worker+持久性verifier | durable proof+连续watermark，不直接清设备日志 |
| request_governance_change / apply_host_result | API / directory受限角色 | saga/deny/epoch+Host回执投影+outbox |
| apply_directory_recovery | work_directory（sync_*_projection同事务内） | 按§3.4只释放满足条件的host_org/host_member/host_seat deny，写审计/outbox；不创建授予、不碰其他来源 |
| request_security_cancel / consume_cancel_intent | revoke命令 / worker | 仅产生或消费取消意图，复用Run取消状态机 |
| finalize_local_artifact / finalize_cloud_replica | worker / content代理 | 版本或replica+hash+event，当前权限/静止条件 |
| recover_local_artifact | work_api经当前owner恢复意图 | 锁Task/原Run/Operation；同manifest/hash/版本且原Run仍latest、无取消/后继/未核账才发布并收尾；不重新执行；否则仅保留恢复对象 |
| authorize_content_chunk | content代理受限角色 | upload/offset/jti/epoch持久消费，先验当前owner/披露/策略后签5s许可，不使用active Run permit |
| set_quota_policy / set_local_policy | 独立治理权限API | revision CAS+epoch+audit+必要取消；不写Host seat |

receipt中的工具结果为本机证据，不冒充provider usage；模型usage必须来自受控egress或签定本机模型适配器并标source。`record_usage → settle_quota` 顺序沿用D-08/E4，绑定同Operation，缺usage用上界estimated；拒绝未发送不伪造模型成功/有usage。

### 4.3 锁序、失败与幂等

统一锁序：组织entitlement/access/policy → 成员restriction（subject排序）→ Task（UUID排序）→ Run → Operation → grant/lease/approval → quota账户（scope/period/id排序）→ reservation → receipt/artifact。组织批量撤权只写deny/epoch/意图，不在同事务锁所有Task，worker逐Task收敛。所有跨模块函数检查相同锁序；现有R0a只锁Task的函数在R0b调用链内需要同序封装/增量修订，不能从Operation锁反向取org锁。

外部Host/mTLS/模型/对象存储调用全部在数据库事务外。不能在数据库commit后对外发包失败就回滚成authorized；已dispatch状态不确定进入unknown。FK/RLS/唯一性和命令角色必须在PG集成测试中逐个反向攻击，不能只靠API的正向检查。

## 5. 审批与只读授权

`Approval pending → approved/rejected/expired/revoked`；决定不可覆盖，重复同actor/hash/decision返回原结果，相反决定409。到期/撤销/批准共用CAS，不能依赖UI计时。现有SQL decide_approval未比较当前policy epoch，R0b必须增量补齐，不能仅暴露旧函数。

创建审批前本机checkpoint必须已持久，控制面将Run waiting(approval)，不常驻Node等待。批准请求需owner当前身份/执行权、revision/hash、local proof、grant/lease所属设备一致；admin没有代批权。批准不是立即执行：恢复重新检查权利、预算、当前session和输入身份；任何变化返回stale，旧决定不扩大新grant范围。

- 默认ask_each：每个list/read/search询问；用户可选“本次运行同类只读允许”，记录readonly_approval_grant及精确工具/资源子树/expiry。不接受模型自报read_only。
- auto_readonly：组织允许且快照允许时只读动作policy_auto，仍登记Operation/hash/审计；写入逐次、外发逐次，不开全访问。
- remember只读授权有效期 `min(24h, run终态,workspace_grant到期)`；重试新Run、重授权新grant、policy epoch改变即失效；UI提供随时撤销。
- pending审批TTL默认10min；过期后取消未dispatch Operation、释放尚未派发预留，Run保持waiting(input)并给“重新预览此动作/结束运行”。重新预览按本机§3.5以 `approval_expired` 取代：同step_key、supersede_no加一、新审批，旧Operation确定canceled且无副作用才可继续；不是自动把expired改pending。
- 用户拒绝当前动作：本期终止整个本次Run（reason=approval_rejected），其他尚未派发动作安全取消，已派发保持核对；已发布成果只读可保留，静止后可采纳。无自动让模型换工具规避拒绝。

Signal只是唤醒，丢失可扫已决定未处理记录补发。RPC response丢失查询同approval决定；不把HTTP重试误当第二次批准。

## 6. 撤权、编排与恢复

### 6.1 撤权流水线

本期实施D-07 B，不由sync_member直接写Run终态。sync在观察到成员离职/seat失去、org停用、权限收窄时同事务增加deny（source按§3.4标注）/access_epoch并写EntitlementNarrowingHint outbox；观察到恢复时只按§3.4释放deny，不发取消也不复活旧Run。hint含 `source_event_id,org,subject?,scope,revision,reason`，不含正文。

Run创建时冻结 `admission_access_epoch` 和依赖grant/device/model/policy revisions。hint另含 `restriction_id,cutoff_access_epoch,affected_resource_id,affected_revision`：成员/org收窄只选择admission_access_epoch≤cutoff的旧授权Run；资源收窄还要求该Run确实引用受影响resource且依赖revision≤affected_revision。worker在Task锁内复核此谓词，不以“当前该成员的所有Run”代替。显式重新授座后新Run使用更高admission epoch，迟到旧hint不能取消它；旧Run即使后来恢复席位仍属于原取消范围，不自动复活。

consumer按 `(event_id,run_id)` 去重，每轮最多100个Task、每组织最多500意图待领；超量保留cursor继续，不跳过。逐Task调用现有取消命令：queued或未dispatch的Operation可确定取消/释放；active已dispatch停止新许可并发设备cancel；suspended/unknown保持waiting(reconcile)。重试指数退避1s至60s，10次后进入dead-letter并告警，仍保留deny；运维只重放意图/信号，不能强置canceled。

撤权事务先提交则新的consume_device_permit必须拒绝；dispatch先提交最多已有短许可在途，Broker尽力停止可控进程，无法撤回已发送provider请求。Host外部变更最大新鲜度窗口见§2.2，必须监控目录事件滞后/AccessProof过期，不沿用R0a五分钟周期作为本机新动作安全凭证。

### 6.2 等待与终态

| 触发 | Run/Operation | 下一步 |
|---|---|---|
| 等待用户审批 | waiting(approval) / waiting_approval | checkpoint后释放Runtime |
| 设备掉线且无在途动作 | waiting(device) | 保持原目标，连接恢复后复验；默认15min后安全失败 |
| 掉线且可能已dispatch | waiting(reconcile) / unknown | 收原设备journal或provider证据，不用设备等待timeout释放 |
| Agent重启/目录失效 | waiting(input) | 用户在原设备对同一目录改绑（`POST /runs/{id}/workspace-rebinds`）；已dispatch先核对；未执行步骤按本机§3.5取代，不得直接换grant重放；选择不同目录则只能结束 |
| 配额不足且无在途动作 | waiting(quota) | 阈值/Run上限不可静默放宽；需合法配置或结束 |
| 模型已计量但回答未送达 | waiting(input) / succeeded，delivery_state=undelivered | 用户结束Run或明确重发（新logical_key+新预留+逐次人工审批），见本机§5.3 |
| 用户取消/安全撤权 | cancel_requested | stopped/receipt核实后终态；unknown仍保留且阻断后继 |
| Broker提议completed且§6.4全部通过 | succeeded，Task awaiting_acceptance | 只有用户明确采纳才completed |
| Broker提议failed | failed，Task保持open | 已有unknown继续保留并阻断后继，run_sealed推迟到全部核账；成果按原规则只读 |

设备disconnect本身不自动创建新Run；模型请求的Temporal activity禁止自动重试发送，只重试幂等查询/账本命令。恢复使用原run/logical_key/operation/receipt；同一设备新session只领未执行且已重新批准的动作。旧fence回执允许核账但不能发布新成果。15min等等待超时不是unknown清理期限。

### 6.3 设备、内容、组织的停止范围

目录revoke立即本地失效句柄并通知控制面；云端撤销后device lease/permit到期制约离线设备。目录撤销只影响引用该grant的动作，组织停用覆盖全组织，成员离职覆盖该owner；已派发动作皆核账，其他已获授权历史成果是否可读按当前ACL与安全原因，不因token耗尽全部封锁。

所有权转移不移交本机目录/设备/审批。离职任务可由既有运营工单命令转移元数据及原本允许的云replica；前提先停止/核对Run、使旧approval/grant失效。local-only正文不能假装随Task迁给另一人；新owner只看到不可访问说明，需要原owner在仍有权时显式同步或独立交付，不能由管理员代读。R0b不增加通用协作/分享。

### 6.4 本机 Run 编排与收尾裁决

本机 Run 使用独立的 `RunWorkflowLocal`，不走 `RunWorkflowAdvance`（后者在 Activity 内调用 Node 片段并提交云端 canonical head）。工作流只持 ID/状态，依次执行：`create_device_run_binding` → 发 run_offer → 等 run_ready → `acquire_device_lease` → 发 run_start → 等待终态。设备事件由 gateway 经领域命令**先提交数据库**，再给工作流发 signal；signal 只负责唤醒，丢失时靠扫描补发，工作流依据重读的 Run 状态继续。工作流不替设备判定成功，也不调用 `FinishRun` 把本机 Run 标为 succeeded。

`finish_local_run` 按§4.3锁序（Task → Run → Operation → lease → receipt/artifact）校验：

1. 签名、session、lease、fence、binding_revision 精确匹配当前值；旧 fence 返回 `stale_fence` 且不写状态。同 finish_id 重放返回原结果，异 payload 冲突。
2. Run 属于当前 Task 且 Task 为 open。`cancel_requested` 下提议 completed 返回 `run_cancel_requested`（沿用 `finish_run` 语义，取消优先）；提议 failed 则转入取消收尾，不覆盖取消原因。
3. 登记 final checkpoint；`receipt_through_seq` 连续；`final_operation_set_hash` 等于服务端按 Operation id/state/result hash 重算的值。不符返回 `finish_state_mismatch`，不写状态。
4. outcome=completed 还要求：无阻塞 Operation（复用 `task_has_blocking_operation`，含 prepared/waiting_approval/authorized/dispatching/unknown/unresolved）、无 `delivery_state` 为 pending 或 undelivered 的调度、`deliverable_versions` 非空且都是本 Run 已发布的 local_only 版本。任一不满足返回 `finish_precondition_failed`，不写状态。
5. 通过后同事务调用 `finish_run(succeeded|failed)`、写 device_run_finish、释放 lease、binding 置 finished、写 event/outbox，并返回 terminal_run_revision。

设备不发 run_finish（崩溃、离线、撤权）时不推断结果，按§6.2 的 device/reconcile/input 等待及超时路径处理；可恢复时走 resume offer。Node 无法通过伪造完成绕过以上校验，成果也仍需用户采纳。收尾只校验 Run 与取消状态；撤权在 hint 消费前到达的窗口内 Run 仍可能 succeeded，但采纳、读取和新动作都复验当前权限。

## 7. 成果、正文同步与事件

### 7.1 本机版本与采纳事务

Device receipt绑定 `version_id,hash,bytes,format,local_ref,device_id`，满足输出profile、本机write Operation完成、active_run/fence匹配、未取消及当前权限才发布ArtifactVersion。结果receipt与核账先落盘，后由§6.4完成Run；artifact消息到达不等于用户采纳。

`finalize_local_artifact` 不复用 `publish_artifact`（后者要求 content_ref 非空），但保持相同的 Run 状态门槛（active/waiting）和 logical_name→artifact 归并、`source=run`、同 run/hash 幂等语义。

用户保存走 `create_local_user_artifact_version`，也不复用 `create_user_artifact_version`（后者要求 content_ref 非空且无设备证明），但保持同样的门槛。事务内先按 `(org,subject,'artifact.version',client_request_id)` 查去重：命中且 hash 同则返回原结果和 publish_ack，**此时不再校验 proof 到期或消费 nonce**；异 payload 409。未命中则依次校验：

1. 当前 Host session、requireSeat、无适用 access_restriction 和组织停用；proof 字段与 HTTP 逐项相等、验签通过、设备 active、session 当前、未过期，并原子消费 nonce；
2. Task 属于当前 owner 且未删除，state 为 open 或 awaiting_acceptance，`active_run_id IS NULL`，latest Run 不是 failed/canceled；
3. artifact 未删除，`base_version_no` 等于最新已发布版本（否则 `version_conflict`），base 为 local_only 且 device_id、hash 与 proof 一致（否则 `content_on_original_device`），classification 不低于 base；
4. 字节数、格式符合输出 profile，version_id 未被占用。

通过后发布 `source=user, location=local_only`、version_no=最新+1 的版本，task/artifact revision 加一，写 `artifact.published` 事件、审计和去重行，返回 ArtifactVersionV2 与 publish_ack。不创建 Operation、Approval 或 reservation，不改变 Run，也不把未采纳任务转为其他状态。席位被撤后不能保存，但已发布版本的读取仍按 §7.1 与本机 §7.3 的 ACL 规则。

Acceptance复用Task/Run静止门槛，检查全部prepared/waiting_approval/authorized/dispatching/unknown/unresolved，不只active_run。local-only需要本机当前possession proof；Web/手机只能看元数据，不能用缺正文的预览假采纳。用户理由完成不计成果采纳；取消/归档Task只读，不借新API复活。

### 7.2 同步状态机

`requested → uploading → verified → published`，另有canceled/expired/failed。session TTL15min，单版本限profile且任务总量不变；上传hash/bytes与原version一致。upload ticket短期、audience专用且绑定session/user/org/version，不能作为任意Content Store写凭据。PUT成功不对外可见，finalize事务核对本机披露决定、当前分类/策略/ACL，创建唯一cloud replica及审计。finalize响应丢失查询同session，不能再创版本；policy收窄后拒绝发布并清staging。

上传权限消费必须发生在首字节离开设备**之前**：Broker请求chunk-permit，服务端在事务中复验当前ACL/policy epoch/披露决定/hash并写入 `content_transfer_chunk(upload_id,offset,length,hash,permit_jti,state)` 唯一记录后签发5s许可。许可绑定org/subject/device/session/upload/version/full_hash/chunk_hash/offset/length/epoch/expiry，audience=content-upload，不是active Run的执行permit。Broker取得明确成功才发该chunk；content endpoint先校验许可和最新deny再允许body读取，HTTP header不合格直接拒绝。每chunk≤64KiB，总量≤262144；下一chunk必须新复验，撤权/过期中止后续发送并清staging。已消费许可与撤权的先后有边界：在途最多当前chunk已可能外发，不承诺撤回字节；不能只靠finalize阻断泄漏。ACK丢失查询offset状态，同hash续传仍要新鲜权限，异hash冲突。

本机manifest若被修改/内容hash不符，拒绝上传，不能用同version换正文。同步失败不改变本机Run或采纳结论；云replica没有published就不显示下载。保留/删除继承已签R0a数据类别政策，未知配置fail-closed；删除立即tombstone、异步物理删除/设备确认分别记录，不谎报离线设备擦除完成。

### 7.3 事件契约

SSE沿用每Task序号和Last-Event-ID；新增 `device.waiting,workspace.reauthorization_required,approval.requested,approval.decided,run.cancel_requested,run.reconcile_required,artifact.replica_published`。payload仅ID/状态/revision/计数，完整参数/路径/模型输出不进事件。本机正文只经Broker送入本机内容窗口（本机§1.1），不进主窗口，也不经SSE或HTTP；跨端SSE只状态。游标失效409后取快照，新旧版本客户端都不得依据事件直接授予权限。

治理变化进治理审计与change状态查询，不混入其他owner的Task流。待处理列表的语义包含approval/input/device/reconcile/awaiting_acceptance，不直接复用现行pending=open/queued条件。独立inbox可后置，任务页必须提供所有恢复动作。

## 8. token 护栏、用量与审计

### 8.1 不改变D-08

`run_cap_tokens`正整数、组织配置上限不超过平台上限；执行有效上限=`min(snapshot_limit,current_policy_limit)`，上调仅影响新Run或新preview，不扩大既有Run快照；下调若已消费/预留超新值，不改历史、不倒扣、不取消已确认在途结算，只停止后续新许可并说明。客户周期 `soft` 只告警，演示周期 `hard` 拒绝超量；UI不可切换此商业属性。

组织/用户每日、月统计按provider/model分列 input/output/cached，input/output计入Run上限，cached独立展示不重复累计。并发预留同固定锁序，one-active-reservation维持；period_id固定到原预留账期，跨日不双扣。unknown保留reservation直到权威对账，不能因管理员降额、结束Run或过期job释放。

本机模型也登记token/时间资源上界；费用显示“仅供参考，以云厂商账单为准”，不出现cents/currency/price_version。缺usage=estimated upper bound，明确估算而非声称provider真实值。控制面必须预留最终装配token上界，不能仅按goal字符数预留。

### 8.2 策略写入

PATCH配额/本机策略要求request_id+expected_revision，服务端比较当前权限proof；响应effective_revision与对在途影响摘要。平台工具/profile、组织上界、任务快照交集生效；管理员不得填未知工具/目的地、解除安全deny、关闭审计、开放remote或执行脚本。策略扩大需新preview，收窄立即提升epoch、取消相关未消费许可并发取消意图。

### 8.3 审计与导出

复用R0a audit_export作业/claim/lease/一次性download token。覆盖配对/撤设备、授权/撤目录、审批/拒绝/过期/remember/revoke、Host席位saga各阶段、委派、策略、配额、dispatch/unknown/reconcile、sync/delete。字段为actor/org/time/action/object IDs、旧新revision、reason、hash/proof_ref；不含本机绝对路径、摘录、token值、provider Key。

导出范围包括时间窗/actor/action、默认365天审计留存的已签边界，分页分批；每次claim和下载复验权限，撤权后禁止新的正文响应。CSV防公式注入，文件名固定、安全Content-Disposition，一次性令牌不进日志/URL。作业重复执行只发布同一版本，导出本身写审计；无执行seat的合法export持有者也可导出，无export的audit.read只可查询。

### 8.4 模型与执行 profile 的获取、探测和生命周期

ExecutionProfile不可变发布对象由 `GET /execution-profiles/{id}/revisions/{revision}` 返回，含revision/content_hash，bootstrap与preview引用同一版本；未知版本404，hash不符拒绝运行。固定模板/工具schema/hash也来自该发布对象，不能仅拿运行时名称推断能力。

ModelProfile按 `org_remote/org_private/device_local` 区分，字段为 `id,revision,content_hash,kind,provider,model,api_type,residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,max_output_tokens,usage_mode,status`；status=draft/probing/verified/active/revoked。org_remote仍保持D-08每组织单一生效云端配置，不增加自动多厂商路由。R0b本机/私有profile是明确的执行目标能力，不改R0a默认配置，不允许按可用性偷偷切换。

| 端点（/work/v2） | 请求/结果 | 权限/持久合同 |
|---|---|---|
| GET /execution-profiles/{id}/revisions/{revision} | 不可变ExecutionProfile+hash | 当前用户可用profile；不含凭据 |
| GET/POST /admin/model-profiles | 列表 / request_id+profile字段+expected_revision；201 draft | 组织owner写，继承D-08近期认证与强审计；读取只返回获准元数据 |
| POST /admin/model-profiles/{id}/probes | request_id+profile_revision；202 probe_id | 组织owner；org_remote/org_private按受控配置探测，不立即激活 |
| GET /admin/model-probes/{id} | queued/running/verified/failed/reconcile、usage、safe_error | 当前owner；没有receipt不猜verified |
| POST /admin/model-profiles/{id}/activate | request_id+profile_revision+probe_id或policy_validation_id+expected_active_revision | owner；远程/私有需同hash/revision已verified探测；device_local仅发布静态审核的endpoint policy，设备binding另需真实probe，不更新既有快照 |
| POST /admin/model-profiles/{id}/revoke | request_id+revision+reason | owner；提升model epoch，停止新许可/定向取消，旧receipt仍核账 |
| POST /devices/{id}/model-bindings | request_id、approved_model_profile_id/revision/hash、device/session、binding_hash、native_confirmation_proof；201 binding+固定探测模板的probe_preview/hash/上界/60s expiry | 当前设备owner+执行席位，限组织已active的device_local profile，不是修改组织配置 |
| POST /devices/{id}/model-bindings/{binding}/probes、GET /devices/{id}/model-probes/{probe} | 当前设备local_intent+request_id / probe状态 | 同设备owner；不能由其他桌面/网页派发，遵守R0b无远程执行 |
| POST /devices/{id}/model-bindings/{binding}/rotate、POST /devices/{id}/model-bindings/{binding}/revoke | request_id+revision+本机确认proof | 只更新该设备密钥引用/失效binding；rotate须重新探测，未verified不可执行 |

组织profile只允许审核后的endpoint_policy：device_local为固定loopback端口/API/model规则，端口变化超出规则需owner发布新profile；org_private为固定TLS目标/解析IP策略，禁redirect/metadata地址。设备本地binding经Broker原生`configureLocalModel`/`probeLocalModel`/`rotateLocalModelCredential`/`revokeLocalModelBinding`窄IPC创建；renderer不能传任意URL，Broker从签定profile获取候选，凭据在OS秘密存储，云端仅收binding hash/版本/指纹（不收本地密钥）。这些IPC只对真实当前设备用户手势开放，Node不可调用。设备binding不扩大组织允许的模型/目的地，是当前设备对已批准profile的实例绑定。

探测本身走受控模型出口或Broker，不绕过计量。沿用Task/Run/Operation账本建立 `task_kind=configuration_probe` 的短Run，仅配置面显示，禁止普通任务API创建该kind；固定无用户正文的探测模板、无文件工具、最多一个模型请求、output≤16 tokens，总预留使用已验证tokenizer算固定模板+输出上界。组织配置探测按治理owner权限创建（不要求个人执行seat，但仍受组织开通/安全deny/配额约束）；设备binding探测必须执行seat+本机intent。两者都是明确用户点击的计量动作，不是后台预热；profile必须提供有限token/context/bytes上界才能开始probe，未verified候选只能用于此固定probe。

device_local的组织profile只做静态policy校验（schema、平台允许的endpoint规则、上界、owner批准），记录validation_kind=policy_only，不能写成模型可用；active policy使设备可以建立binding，设备probe才能使binding verified，避免“必须先active才能probe、必须probe才能active”的循环。设备probe的local_intent绑定服务端返回的probe_preview_hash、固定模板hash、binding/profile版本及当前设备session，原生确认之后提交；过期重新取preview但不重放旧probe。ExecutionProfile只有该设备binding verified才可发送真实任务。

同probe_id/command重复查询不重发，候选版本已有unknown probe时禁止新probe，保持原Operation预留并等待核对；失败不生效、不回退其他账号。探测回执绑定profile/binding hash和revision，verified后修改任一参数都新建revision并重新probe。设备binding探测通过仅使该设备binding可用，不能把组织未批准profile变active。远程配置/凭据rotation沿用D-08写而不回读和旧凭据在途核账规则；旧snapshot继续绑定旧route revision但必须受当前revoke epoch约束。

实现落表：Work `model_profile_revision`（org/id/revision唯一、hash不可变）、`device_model_binding`（org/device/id/revision、profile FK、status、local_ref/hash）、`model_profile_probe`（org/probe_id、task/run/operation、candidate_hash、state、receipt_ref唯一）。设备只将本机秘密存OS库；Host不持模型配置。此增量不把modelprofile注册表变成R1技能/套件Registry。

## 9. 错误、冲突与安全重试合同

`retryable`只表示可重复**同一幂等请求/查询**，不表示可再次执行模型或工具。`recovery_action`为闭集：`reauthenticate,refresh_state,repreview,reauthorize_workspace,reconnect_original_device,reconcile_operation,query_change,upgrade_client,reduce_input,contact_operator,none`；客户端未知码只读并刷新，不默认给“重试执行”。HTTP错误不回显Action/body/path，原始内部错误只映射为固定码与correlation_id。

| code / HTTP | 发生条件 | retryable / recovery_action | 安全后果 |
|---|---|---|---|
| session_invalid / 401 | Host会话失效；不适用于独立recovery身份 | false / reauthenticate | 禁止新业务写；重新登录不恢复旧grant |
| permission_denied / 403 | 当前细分权限或owner/对象ACL不满足 | false / refresh_state | 不依靠bootstrap缓存，不重放越权写 |
| client_upgrade_required / 409 | v1请求local资源或协议/profile不兼容 | false / upgrade_client | 保留原任务，只读/升级，不降隔离 |
| idempotency_conflict / 409 | 同request_id不同规范payload | false / refresh_state | 返回冲突，不生成第二Task或Operation |
| preview_stale / 409 | preview到期或input/target/epoch不相等 | false / repreview | 新预览须用户确认，旧submit不自动替换 |
| source_changed / 409 | 获批source hash与实际封存buffer不同 | false / repreview | 不交付新bytes，不扩展原批准 |
| workspace_changed / 409 | root身份/祖先/输出目标已改变或冲突 | false / reauthorize_workspace | 句柄失效，不用原路径二次打开 |
| workspace_identity_changed / 409 | 改绑时新目录与Run原目录identity不同 | false / none | 原Run只能结束；不允许换目录续跑 |
| supersede_not_allowed / 409 | 旧Operation缺未执行证明、为unknown、已被取代，或新Action超出允许变化范围 | false / reconcile_operation | 不建新Operation；unknown继续核账 |
| supersede_limit_exceeded / 409 | 同step_key取代超过5次 | false / none | Run转waiting(input)，用户只能结束 |
| approval_stale_or_expired / 409 | decision revision/hash/expiry/epoch失效 | false / refresh_state | 查询决定；不自动批准新Action |
| execution_unknown / 409 | dispatch窗口或外部结果不明 | false / reconcile_operation | 同Operation核账；不得换key、释放预留或重发 |
| run_not_quiescent / 409 | 仍有运行或阻塞Operation | false / refresh_state | 拒绝采纳/新Run；不能先改Task为completed |
| input_limit_exceeded / 422 | 合法编码但标量/token/profile上限不满足 | false / reduce_input | 返回field/unit/actual/limit，不回显正文；无provider调用 |
| request_too_large / 413 | HTTP完整请求或chunk字节超限 | false / reduce_input | 不读取超限body；不截断后继续 |
| entitlement_incomplete / 409 | Host未确认开通/seat_limit上界 | false / query_change | 保留pending/deny，不猜套餐或增权 |
| org_suspended / 403 | Host组织停用或归档，host_org deny生效 | false / contact_operator | 只能等服务方在Host恢复；组织owner与治理权限无法解除 |
| member_inactive / 403 | 本人归并状态非active，host_member deny生效 | false / contact_operator | 恢复后也须新会话；旧grant/Run不复活 |
| governance_revision_conflict / 409 | expected_revision过时或未决相反命令 | false / query_change | 查询原change，不自动改成反向授权 |
| device_offline / 409 | 原设备无法领取新动作 | false / reconnect_original_device | 保持原目标；已dispatch另走unknown |
| model_answer_undelivered / 409 | egress已记成功并计量，但设备未收到回答 | false / refresh_state | 不补取回答、不自动重发；用户结束Run或明确重发，且再次计量 |
| content_on_original_device / 409 | local_only版本的读取或保存不在原设备发生 | false / reconnect_original_device | 不代理正文，不把空content_ref交给Content Store |
| local_proof_expired / 409 | UserVersionProof过期且去重未命中 | false / refresh_state | 未发布；本机转draft，须用户重新确认 |
| run_cancel_requested、stale_fence、finish_state_mismatch、finish_precondition_failed（run_finish_ack.code） | 收尾校验失败，见§6.4 | 帧内返回 / 不适用 | 不写Run状态；设备按本机§3.4处理，不改写成果事实 |
| transfer_permission_stale / 409 | chunk许可过期/撤权/披露或hash变化 | false / refresh_state | 发包前拒绝；已在途chunk停止后续，不等finalize才挡 |
| service_degraded / 503 | Host/持久边界/领域服务不可确认 | true / refresh_state | 仅查询或同请求ID重发内部请求；无确定dispatch成功不发送 |
| rate_limited / 429 | 设备/查询/治理速率超过边界 | true / refresh_state | 遵守Retry-After，不创建新逻辑key绕过限制 |

gRPC对应映射：身份失败UNAUTHENTICATED、权限PERMISSION_DENIED、版本FAILED_PRECONDITION、revision/hash冲突ABORTED、大小/速率RESOURCE_EXHAUSTED、服务不可用UNAVAILABLE；业务code仍放闭合Error消息。收到未知required_feature用FAILED_PRECONDITION终止握手，不忽略字段后继续。

`GET /admin/changes/{id}` 的pending/reconcile是200业务状态，不伪装网络错误；客户端允许查原change而不重发新命令。`rejected_not_executed`是可信执行结果而非通用HTTP错误：只有权威回执才能证明未执行，供应商超时/任意4xx不能映射成它。

## 10. 安全与实施签收输入

需独立复核的新入口：Host委派/席位写与幂等审计、Host WorkMemberState归并与Membership.work_seat迁移、deny来源分类与apply_directory_recovery、设备CA/证书轮换、设备签署local_intent和审批、consume_device_permit、设备专用egress入口与ExchangeLocal（公网暴露面、正文零落盘）、finish_local_run、create_local_user_artifact_version与UserVersionProof、动作取代校验与同目录改绑（GrantSuccessionProof）、本机内容窗口的无网络隔离、receipt验签/settlement、journal_release持久证明、实时deny/cancel、内容ticket/sync。旧R0a的worker/egress身份不能自动获得新设备授权函数；新增最小角色grant矩阵需PG负例验证。

实施必须补R0b OpenAPI v2/Protobuf v2/JSON schema、客户端生成、migration目录漂移测试、固定签名向量、每状态正反例、并发CAS/跨租户/跨设备/重放测试；本设计表格给出了实现合同，不宣称已有可执行schema/代码生成或测试通过。实现前必须把所有本文领域命令映射到版本化schema与测试，不仅检查端点数。完整验收 oracle 见体验 §6–§9。
