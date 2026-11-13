# Work 安全边界

> 定位：本文只说明 Work 必须满足的安全属性、信任边界、以及当前是否已验证。
> 详细安全行为由代码、迁移、契约和测试证明；本文不复制实现细节、不列错误码、不贴 SQL。
>
> 状态基线：2026-11-14。机器可读来源 [status.json](status.json)，渲染见 [status.md](status.md)。
>
> **总体结论（不美化）**：多轮设计自查完成；**外部独立安全审计未执行**。
> 2026-11-01 起项目单人开发、无独立复核人，对外不得称"经独立复核/审计通过"。
> **不允许真实客户数据**；试点 go/no-go 当前为 **no-go**（C17 SLO 未实测）。

## 验证状态的读法

- **已验证**：有可复跑测试或生产实测负例；**部分**：核心有证据，残口已点名。
- **未验证**：只有设计/参考实现；**未实现**：能力不存在，签署例外写明重开条件。

设计/参考证据（mock、faux model、一次性 PG、本地扫描）不等于生产证明。

## 信任边界总览

- 浏览器/前端（不可信）→ Work API：会话 cookie + CSRF，org/subject 只来自 Host 验真。
- Work API → Host 内网端点：专用 CA 的 mTLS，验真与目录拉取，公网不暴露。
- 控制面 → 执行面（runtime/egress/content-proxy）：按信任域拆部署（ADR-0019），执行面不直连 PG，只经 work-authz 白名单领域命令，身份来自工作负载证书。
- Host 目录 → Work 投影：唯一跨系统身份写入面，单写者 + 单调修订号。
- 管理面 → 审计导出：只读、绑组织、一次性下载凭证，正文不入导出。
- 内容域：正文在 PG 之外按 org 加密存储，事件/日志只带 ref/hash。

按安全边界拆部署是已定决策（ADR-0019，Proposed）；现网 systemd 单元、loopback 监听与 meet 后端 NetworkPolicy 已按此部署，独立售卖级剥离演练未做。

## 1. 身份认证

**必须满足的安全属性**

- 身份唯一来源是 Host 对浏览器 `sessionid` cookie 的验真；org/subject 绝不取自
  请求体或客户端自报，cookie 名只认 Host 实际使用的那一个。
- 验真走 Host 内网 mTLS 端点；失败、超时、缺字段一律 fail closed，零正向缓存，
  会话撤销对下一个请求立即生效；cookie 值不进日志/错误/指标/trace。
- 验真通过后按请求建立 PG RLS 事务上下文（角色 + org + subject，事务内有效，
  提交前清除），池化连接不残留租户身份。
- `bootstrap` 签发 Go HMAC CSRF token（`work_csrf`），绑定 subject/org/session_revision。

**当前验证状态**：已验证（生产演示组织）。2026-10-29 真实会话 bootstrap 200，
`realHostIntegrationVerified=true`；缺失/错名/重复/伪造 cookie、Host 不可用/超时/
缺字段/时间偏移负例均通过（HW-N1/N2）。**部分**：Host 身份与席位字段（C31/P1-A）
仍未接真实数据，当前只有演示组织。

**权威代码/测试**：`src/work/internal/api/auth.go`、`bootstrap.go`；
`src/work/internal/host/client.go`；`src/backend/core/api/work_host.py`；
[Host wire 决策](design/work-r0a-host-wire-decision-2026-10-28.md)（HW-01/HW-05）。

## 2. 组织隔离 / RLS

**必须满足的安全属性**

- 全部租户表 FORCE RLS；org 上下文缺失时任何登录角色读到的都是空集。
- 应用角色无直接 DML，写路径只经领域命令；跨租户上下文在命令层拒绝。
- 投影只允许 `work_directory` 角色经 `sync_org_projection`/`sync_member_projection`
  写入；修订号单调、同修订异事实拒绝；`operator_suspended` 不被目录覆盖；
  批量缺席有闸门，需显式放行并留审计。
- 失权在下一次授权/提交/重试即被拒；在途 Run 不自动取消（D-07 A），由值班按
  runbook 手工停止，窗口内继续消耗配额是已接受风险。

**当前验证状态**：已验证（PG 测试 + 生产同步实测：full/incremental、mass-absence
闸门、角色最小权限均有负例）。**部分**：生产形态连接池/负载复核未做（C12 残口）；
真实 P1-A 身份字段未接（C31）。

**权威代码/测试**：`src/work/internal/db/context.go` + `context_test.go`；
`src/work/migrations/`；`src/work/internal/api/tenant_isolation_sweep_pg_test.go`、
`cross_org_write_sweep_pg_test.go`、`route_authorization_sweep_pg_test.go`、
`function_privilege_sweep_pg_test.go`；`src/work/internal/directory/`；
[Host wire 决策](design/work-r0a-host-wire-decision-2026-10-28.md) §3/§8；
[D6](design/work-r0a-security-ops-migration-design-2026-10-25.md) S02/S17。

## 3. Host mTLS

**必须满足的安全属性**

- 专用 `work-host-ca`；Go 控制面客户端证书 CN 固定 `work-control-plane`，
  Host 只信任该 CA，校验证书存在、CA、有效期、clientAuth EKU 与 CN。
- Host 端点只在内网暴露，不建公网 DNS；Django 是强制校验点
  （ingress `optional` 是已签决策，不改变强制校验位置）。
- CA/客户端私钥只存 Work ECS 受限目录，不进仓库/Secret/日志；证书到期有预警。

**当前验证状态**：已验证（2026-10-28 生产负例矩阵：无证书、自签、错误 CN 均拒，
有效证书通过；跨机链路打通）。已签残余风险：ingress 不前置拒绝无证书请求；
同命名空间 agent 被攻破可伪造客户端证书头；单 CA 硬切换限制与吊销缺口见 runbook。

**权威代码/测试**：`src/backend/core/api/work_host.py`；`deploy/aliyun/` 与 Helm
`workHost` 配置；[Host wire 决策](design/work-r0a-host-wire-decision-2026-10-28.md)
§4/§6/§10；[运维 runbook](design/work-operations-runbook-2026-10-25.md) §5.5。

## 4. CSRF

**必须满足的安全属性**

- Go 签发 HMAC-SHA256 token，绑定 sub/org/rev/exp；密钥独立于 Host/Temporal/DB，
  按版本轮换，不进日志/仓库；不读取 Django CSRF 内部实现。
- 双提交：`work_csrf` cookie 与 `X-CSRF-Token` 头必须完全一致并通过 HMAC；
  不接受别名头；GET/SSE 不要求。
- cookie：Secure、SameSite=Strict、Path=/work、host-only、非 HttpOnly（多标签页
  共享读取）；API 与前端同源部署。
- 校验先于任何副作用和 DB 写；登录/会话刷新/权限提升/撤销后旧 token 失效。

**当前验证状态**：已验证。签发/校验/过期/cookie 属性有单测；写端点已在处理链路
消费 CSRF（"尚无写端点消费"的旧口径已于 2026-11-01 更正，见 HW-N3 注记）。

**权威代码/测试**：`src/work/internal/api/csrf.go` + `csrf_test.go`、`auth.go`
（verifyCSRF）及 `inputs.go`/`previews.go`/`task_detail.go`/`admin.go` 的调用点；
[Host wire 决策](design/work-r0a-host-wire-decision-2026-10-28.md) HW-02/HW-N3。

## 5. Content Store

**必须满足的安全属性**

- 正文不进 PG：PG 只存 content_ref/hash/bytes；正文 AES-256-GCM 加密，密钥按 org
  从主密钥派生，org 参与 AAD，跨组织解密必须失败。
- 不向调用方暴露宿主路径；读取绑定租户与执行，逐请求复验授权；tombstone 引用拒绝。
- 正文不进日志/事件/trace，只允许 ref/hash/usage 等公开事实。

**当前验证状态**：**部分**。当前是本地 pilot 实现：`work-content-proxy:8444` 已上线
（loopback，server TLS + bearer，**不是 mTLS**），自 2026-10-31 起**零真实请求**，
路由属测试证明而非生产证明。往返/租户隔离/篡改拒收/执行绑定有 PG+HTTP 用例。
**未实现**：key_version 重加密（全部调用点 keyVersion=1，ref 的 `?v=` 预留未接线）；
对象存储后端与规模化擦除（内容留存删除清扫）转 R0b。注意区分：输入 24h TTL 清扫
与 content_shred 交接已实现并有测试（relay），那是输入留存，不是 Content Store
对象级留存。

**权威代码/测试**：`src/work/internal/content/local.go` + `local_test.go`；
`src/work/internal/contentproxy/`（`contentproxy_pg_test.go`、`tls_test.go`）；
`src/work/internal/relay/shared_ref_shred_pg_test.go`；
[pilot-checklist](../plan/assets/work-r0a-ops-2026-10-25/pilot-checklist.json) C09/C13；
[D6](design/work-r0a-security-ops-migration-design-2026-10-25.md) S09。

## 6. Runtime 沙箱

**必须满足的安全属性（设计目标）**

- 每 Run 隔离（目标 gVisor）、非 root、只读根文件系统、无宿主挂载、仅经网关出网。
- Runtime 不持有长期供应商 Key；模型/工具动作只经受控网关，策略/预算/凭据注入/审计在模型之外强制（ADR-0012）；外部副作用至多一次许可 + 可核对回执，unknown 禁止盲重试（ADR-0013）。
- 目录授权是资源范围，不是隔离证明（ADR-0015）；任意 Shell/脚本必须另有 OS 隔离，无法满足隔离就不开放工具。

**现实（必须如实表述）**：**生产当前没有容器隔离**。2026-11-04 主机实测 runc/runsc/containerd/dockerd/podman/bubblewrap 全部 ABSENT，子进程由同一 node 解释器裸 spawn；`sandbox-profile.json` 为 `profile=process_only`、`sandboxProof=false`，gvisor 只是 targetProfile。已签例外 S1=A：对外一律表述为"进程级隔离＋凭据作用域"，不得把容器隔离/gVisor/每 Run 一 Pod 写成已实现。

**在位的补偿控制（有对手测试）**：子进程 env 白名单（DB/Temporal/供应商/主密钥变量不到达子进程，哨兵断言）；agent 无工具面、无 getApiKey；内部监听只绑 127.0.0.1；每 run nonce + 短效 scoped capability；stub 拒启。执行面身份：runtime/egress 不直连 PG，只经 work-authz（8443，强制客户端证书）的白名单领域命令；身份来自注册证书指纹，吊销=registry 热加载（秒级；无 CRL/OCSP）。

**残余风险（明写，不消解）**：被提示操控的子进程可把本次 Run 已取到的内容发往任意公网地址；宿主无 mount/syscall/pid/network 任一层围栏。缓解只收窄"凭据"维，不收窄"数据外带"维。

**当前验证状态**：隔离证明**未验证**（sandboxProof=false，无逃逸测试）；补偿控制已验证（哨兵/握手测试）；真实供应商仅一次 Qwen smoke，真实供应商 E2E 未跑。**重开条件**（任一出现即退回 todo 并补隔离）：真实客户数据进入试点；池并发超过 maxConcurrent 且被用于正确性；R0b 本机执行或池化恢复启用。

**权威代码/测试**：`docs/plan/assets/work-r0a-runtime-2026-10-25/policy/sandbox-profile.json` + `evaluator.test.mjs`（声称隔离证明即红）；`src/work/node/src/supervisor.mjs`、`child-pi.mjs` + `test/supervisor-handshake.test.mjs`；`src/work/internal/authz/`（`authz.go`、`registry_store.go`、`mtls_test.go`）；[隔离例外单（已归档）](archive/work-r0a-runtime-isolation-exception-2026-11-04.md)；[ADR-0012](../adr/0012-controlled-egress.md)、[ADR-0013](../adr/0013-unknown-side-effects.md)、[ADR-0015](../adr/0015-directory-grant-not-sandbox.md)；[威胁模型](design/work-threat-model-2026-10-25.md) §4。

## 7. 密钥生命周期

**必须满足的安全属性**

- 静态单层加密（D-03 B）：全局主密钥 + 按 org 派生；内容密钥与供应商凭证密钥
  用不同派生前缀做域分离。
- 主密钥只来自进程环境/受保护文件，不落 DB/仓库/日志；无云 KMS/HSM。
- 供应商凭证只写不回读：API 只返回指纹与脱敏元数据；创建/轮换/吊销写审计，
  审计不含密钥材料。
- 凭证可吊销，吊销即时生效。

**当前验证状态**：加密、只写不回读、吊销**已验证**（单测 + PG 用例）。
**未实现（签署的范围例外，不是待补缺口）**：云 KMS 未接；试点期单主密钥、不轮换，
重加密驱动未实现——D-03 B + #40 A 裁定，带重开条件：>3 组织/规模化前、疑似主密钥
泄露需轮换、或接入对象存储后端。本地 KMS envelope 6/6 只是参考实现，不是云 KMS
证据；无托管 KMS/HSM 审计轨。

**权威代码/测试**：`src/work/internal/credentials/credentials.go` +
`credentials_test.go`；`src/work/internal/api/provider_config_set.go`、
`provider_config_revoke.go` 及对应测试；
[pilot-checklist](../plan/assets/work-r0a-ops-2026-10-25/pilot-checklist.json) C13；
[D6](design/work-r0a-security-ops-migration-design-2026-10-25.md) S03/S14；
`docs/plan/assets/work-r0a-hardening-2026-10-25/kms-envelope.mjs`（仅参考）。

## 8. 审计

**必须满足的安全属性**

- 审计事实 append-only：UPDATE/DELETE 在 DB 层被拒（审批/配额/任务事件同约束）。
- 治理读与导出动作全部写审计，不含正文；导出作业只含元数据。
- 下载是一次性短期 token，只走 `X-Download-Token` 头（不进 URL/查询串），库内只存
  SHA-256，兑换一次即失效；跨组织与不存在统一 404，不泄露存在性。
- 留存政策（2026-10-27 已签）：审计 365 天；输入 24h TTL；任务/成果 180 天只读
  归档后导出/删除；用户删除 tombstone + 粉碎。
- 日志/事件/trace 不含正文、Key、cookie。

**当前验证状态**：append-only、导出闸门、一次性 token **已验证**（PG 负例 + 合同
测试）；输入 TTL 清扫与 shred 交接**已验证**（relay 崩溃/共享引用测试）。
**部分/未验证**：180 天归档→导出/删除的生产删除演练未做；生产日志管道
（staging OTel）未接，日志扫描 8/8 只是本地参考证据，不是生产日志审查。

**权威代码/测试**：`src/work/migrations/baseline/0002_initial_r0a_schema.sql`
（append-only 触发器）；`src/work/internal/api/admin.go` +
`audit_export_gate_pg_test.go`、`audit_export_expiry_pg_test.go`、
`audit_export_download_suspended_pg_test.go`、`immutability_pg_test.go`；
`src/work/internal/relay/lease_crash_test.go`、`shared_ref_shred_pg_test.go`；
[D6](design/work-r0a-security-ops-migration-design-2026-10-25.md) S09/S10/S14/S18；
[威胁模型](design/work-threat-model-2026-10-25.md) B8。

## 9. 真实客户数据准入条件

**必须满足的安全属性（硬闸）**

- 接任何真实客户组织或真实客户数据前，**必须先完成外部安全审计**（J39）。
  审计范围经 2026-11-10 裁定收窄为三项：S2 无网络内容窗口、S4 目录绑定、
  S11 Bearer 验真面。
- 审计完成前，对外安全声明只能说"多轮设计自查完成、外部审计未执行"。
- 当前仅允许演示组织 + 演示数据（C15 waived 仅对 R0a 演示成立，不覆盖客户场景）。
- 真实客户数据同时触发多个范围例外的重开条件：Runtime 隔离例外（§6）、
  单主密钥不轮换例外（§7）；届时必须补隔离与密钥轮换/重加密。

**当前验证状态**：外部审计**未执行**（`external_security_audit_done=false`）。
试点 go/no-go 现读见 [status.md](status.md)（C17 SLO 未实测）；闸门绿≠已试点，
也≠残口为零。真实供应商仅一次 Qwen smoke；Host 身份/席位字段
（C31/P1-A）仍未接真实数据。

**权威代码/测试**：
[R0b 签收单](design/work-r0b-security-host-signoff-2026-10-31.md)（J39、§14 自决口径）；
[status.json](status.json)；
[pilot-checklist](../plan/assets/work-r0a-ops-2026-10-25/pilot-checklist.json) +
`goNoGo()`（现读命令见 status.json 的 `pilot_gate_command`）；
[D6](design/work-r0a-security-ops-migration-design-2026-10-25.md) §10。

## 权威来源索引

| 内容 | 来源 |
|---|---|
| 威胁与边界（B1–B8）、沙箱证明边界 | [威胁模型](design/work-threat-model-2026-10-25.md) |
| S01–S18 控制映射、留存政策、go/no-go | [D6](design/work-r0a-security-ops-migration-design-2026-10-25.md) + [security-controls.json](../plan/assets/work-r0a-ops-2026-10-25/security-controls.json) |
| R0b 入口签收台账、J39 审计闸、自决口径 | [R0b 签收单](design/work-r0b-security-host-signoff-2026-10-31.md) |
| mTLS/CSRF/目录同步 wire 与生产负例 | [Host wire 决策](design/work-r0a-host-wire-decision-2026-10-28.md) |
| 受控出口 / unknown / 目录授权≠沙箱 / 服务拆分 | [ADR-0012](../adr/0012-controlled-egress.md)、[0013](../adr/0013-unknown-side-effects.md)、[0015](../adr/0015-directory-grant-not-sandbox.md)、[0019](../adr/0019-security-boundaries-service-split.md) |
| 当前状态（机器可读） | [status.json](status.json) |

本文不替代任何一项证据。关闭条件见威胁模型 §7 与 D6 §13：安全评审签收 + 对应
用例通过 + 供应商书面材料；文档存在本身不构成安全证明。