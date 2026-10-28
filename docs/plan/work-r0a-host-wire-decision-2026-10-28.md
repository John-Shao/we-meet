# Work Host v2 wire 决策与签收（2026-10-28）

> 状态：**John 主签；Lily 对 HW-01–HW-04 安全复核通过（2026-10-28；mTLS、CSRF、fail-closed）；HW-05 细节待复核。** 本文只冻结 wire 与边界，不实现 HTTP/SQL/codegen，也不代表真实 Host 或 mTLS 已接通。
>
> 上游：[Host 合同 v2](assets/work-r0a-rebuild-2026-10-28/host-contract.json)、[D2' 公开契约 §8.3](work-r0a-api-design-2026-10-25.md#83-host-接入合同增量work-host-contract-v2设计已签已复核)、[重做计划 Phase 2](work-r0a-architecture-rebuild-plan-2026-10-28.md#phase-2go-控制面)。

## 0. 结论

| ID | 决策 | 含义 |
|---|---|---|
| HW-01 | SessionVerifier 走内网 mTLS + 原始 session cookie | Go 控制面把浏览器带来的 `sessionid` 原样送到 Host 内网端点验真（2026-10-28 勘误）；Host 返回 `subject_id`/`org_id`/`session_revision`/`verified_at`；失败严格 fail closed，零正向缓存 |
| HW-02 | CSRF 由 Go 签发 HMAC token，`work_csrf` cookie 共享 | token 绑定 `subject_id/org_id/session_revision`；`bootstrap` 返回同一 token；变更请求校验 `X-CSRF-Token`；不读取 Django CSRF 内部实现 |
| HW-03 | OrgDiscovery/同步走批量分页 + revision 游标 | `GET /work-host/v2/orgs` 与 `/orgs/{id}/members?revision_after&cursor&limit`；全量缺席只收窄为 `left`，不删除、不取消 Run |
| HW-04 | 专用 Work Host CA + 客户端 mTLS | Go 控制面持专用客户端证书访问 Host 内网端点；Host 只信任该 CA；端点不暴露公网；内部 hostname/port 由平台回填 |
| HW-05 | Cookie 名勘误 + session_revision 来源 | 线上实际 cookie 用 `sessionid`（`we_meet_session` 作废）；`session_revision` 取 session key 的 63-bit SHA-256 前缀；John 2026-10-28 签 |

John 于 2026-10-28 对 HW-01–HW-04 选择“按推荐方案”，Lily 于同日完成安全复核并通过。可以继续写本地 stub/单元测试，但**不得把真实 Host/mTLS 写成已接通**。

## 1. HW-01 SessionVerifier

### 1.1 端点与请求

```http
POST /work-host/v2/sessions/verify
Cookie: sessionid=<原始值>
X-Work-Request-ID: <correlation id>
```

- 只接受内网 mTLS 客户端；不接受 bearer、不读取请求体里的 org/subject/role/scopes。
- Go 不把 cookie 写入日志、错误、指标标签或 trace 属性；Host 同样不得记录 cookie 值。
- Go 只接受 Host 实际使用的 `sessionid` 这个 cookie 名；其它别名不转发。**2026-10-28 勘误（John）：线上 meet `SESSION_COOKIE_NAME=sessionid`，D2' 初稿的 `we_meet_session` 作废。**

### 1.2 响应

```json
{
  "subject_id": "sub_1",
  "org_id": "org_1",
  "session_revision": 4,
  "verified_at": "2026-10-28T10:00:00Z"
}
```

- `subject_id`/`org_id` 1–128 字符；`verified_at` RFC3339 UTC。
- `session_revision` 定义为 Django `session_key` 的 63-bit 非负哈希（SHA-256 前 8 字节按大端解释后去掉最高位）；同一会话稳定，session key 轮换/登录刷新/登出时变化。它不是权限变更版本；权限提升时的 CSRF 轮换仍按 HW-02 单独处理。
- `verified_at` 距 Go 当前时间超过 60s、或来自未来超过 5s（时钟偏移上限）即拒绝；Host 不可用/超时/非 2xx 一律拒绝。
- 缺失任一字段报 `host_field_gap`，不猜测；额外字段拒绝。
- `401 {"code":"session_invalid"}`；`503 {"code":"session_unverifiable"}`。公开给浏览器的错误仍由 Go 映射为 `unauthorized`/`service_degraded`，不把 Host 原始错误透传。
- 不做正向缓存；会话撤销对下一个请求立即生效。已在途请求不承诺取消。

## 2. HW-02 CSRF

- `bootstrap` 响应包含 `csrf_token`；同时设置：

```http
Set-Cookie: work_csrf=<token>; Path=/work; Secure; SameSite=Strict
```

- `work_csrf` 非 HttpOnly（前端多标签页需要共享读取）；不设置 Domain（host-only）；不设置 `Expires` 超过 token 本身。
- token 格式：`v1.<base64url(payload)>.<base64url(hmac-sha256)>`；payload 只含 `sub`、`org`、`rev`、`exp`（Unix 秒）。TTL 默认 3600s，可配置；`rev` 必须等于本次 Host `session_revision`。
- 变更请求必须带 `X-CSRF-Token`，且必须与 `work_csrf` 完全一致并通过 HMAC；GET/SSE 不要求。禁止接受 `X-CSRFToken`、`X-XSRF-Token` 等别名。
- 失败返回 403 `csrf_invalid` + `recovery_action=refresh_csrf`；客户端只允许重试一次（重新 `bootstrap`）。登录、会话刷新、权限提升、撤销或 `session_revision` 变化时旧 token 失效。
- HMAC 密钥独立于 Host、Temporal 和 DB 密码；按版本轮换；密钥不进日志/仓库。CSRF 校验必须先于任何副作用和 DB 写。

## 3. HW-03 OrgDiscovery 与目录同步

```http
GET /work-host/v2/orgs?cursor=<opaque>&limit=50
GET /work-host/v2/orgs/{org_id}/members?revision_after=<int>&cursor=<opaque>&limit=50
```

```json
{"items":[{"org_id":"org_1","name":"Acme","status":"active","home_region":"cn-north","revision":12}],"next_cursor":null}
{"items":[{"subject_id":"sub_1","status":"active","role":"owner","work_seat":true,"revision":12}],"next_cursor":null}
```

- `limit` 1–100，`cursor` 不透明；`revision_after` 为非负整数，增量按 revision 单调推进；同 revision 异事实拒绝，低 revision 忽略。
- 组织字段：`org_id`、`name`（可空）、`status`、`home_region`、`revision`；成员字段：`subject_id`、`status`、`role`、`work_seat`、`revision`。缺字段报 gap，不猜；额外字段拒绝。
- 全量对账由 Go 定时拉取完整快照；缺席成员只收窄为 `left`，不删除行、不覆盖 `operator_suspended`、不取消 Run。取消仍走 `work.ops_cancel_run`（D-07 A）。
- Go 只经 `work.sync_org_projection` / `work.sync_member_projection`（`work_directory` 角色）写投影；Host 不直接写 Work 表。
- 周期：增量 300s、全量 86400s；失败/积压/投影过期阻断新工作，但允许基于已有投影读取（Host v2 语义）。

## 4. HW-04 身份与网络

- 新建专用 CA（工作名 `work-host-ca`），签发 Go 控制面客户端证书，SAN/workload identity 固定为 `work-control-plane`；Host 只信任该 CA，不接受其它客户端证书。
- Host 端点只在内网 ingress/Service 暴露；不建公网 DNS、不在 meet 公共路由暴露。Go 只使用内部名称解析（F0-R5 硬前置），不使用公网 IP 回退。
- 证书轮换、吊销和私钥存放由平台执行；Go 进程只从只读挂载/环境读取证书路径，不写日志。
- 具体内网 hostname、port、CA 分发方式和 Host 侧部署位置待平台回填；在回填前不写死地址，只提供 `WORK_HOST_BASE_URL` / cert/key/CA 配置项。
- Host 侧端点实现落 meet Host（`src/backend/core` 内的工作负载身份入口），不落 Node Runtime/Pi/egress/前端；Go 侧 adapter 落 `src/work/internal/host` 单向依赖该 wire。
- **Host 侧实现口径（2026-10-28）**：端点落 meet core；mTLS 在 ingress-nginx 终止，`auth-tls-verify-client=on` + `auth-tls-secret=<CA>` 校验客户端证书，`auth-tls-pass-certificate-to-upstream=true` 把 `ssl-client-cert` 传给上游；Django 重新校验 CA、有效期、clientAuth EKU 和 CN `work-control-plane`，拒绝缺失/不匹配。后端不得被其它工作负载直连。2026-10-28 meet 独立 canary 已验证：带客户端证书→401 `session_invalid`（证书校验通过、无会话），不带证书→400（ingress）；canary 验证后已删除。两台机同 VPC（172.16.0.0/16、同网关），无需 peering；安全组已放行 meet 30443 ← 172.16.0.7 与新 ECS 30080 ← 172.16.0.4。2026-10-28 跨机完整链路：新 ECS 带客户端证书→401（证书校验通过），不带→400；用 meet 生产库临时测试身份 + Work 投影，经新 ECS `work-api` → canary → Work RLS 返回 **bootstrap 200**（org/role/seat/CSRF 正确）。canary、临时 user/org/session、Work 投影与临时 DB login 已全部删除。这证明 SessionVerifier 跨机打通；OrgDiscovery/同步随后已实现（见下条），真实部署/联调未执行，`realHostIntegrationVerified` 仍为 false（完整 Host 未验收），生产流量未切。
- **OrgDiscovery/目录同步实现口径（2026-10-28）**：meet 新增 `GET /work-host/v2/orgs` 与 `/orgs/{org_id}/members`（mTLS 同上；cursor 为 UUID keyset 的 base64url；`limit` 1–100；`revision_after` 按成员行 revision 过滤）。为提供权威字段，`Organization` 增加 `home_region`（默认 `cn-north`）、`directory_revision`，`Membership` 增加 `work_seat`（默认 false）、`directory_revision`。**`revision` 是组织级目录序列**：成员 INSERT/UPDATE 先推进所属组织的 `directory_revision`，再把新值盖到成员行；成员 DELETE 与组织自身 UPDATE 也推进。缺字段由 Host 返回 `gaps`，不猜。Django：会话 12/12、OrgDiscovery 19/19、Host 目录字段 6/6。Go 侧 `internal/host` 严格 OrgDiscovery 客户端（分页、循环/协议负例），`internal/directory` + `cmd/work-directory-sync` 经 `work_directory` 角色调用 `work.sync_*`：`execution_enabled := status == 'active'`（与 `we-meet-host-adapter.mjs` 同口径）；`projection_revision_stale` 视为已应用；gap 行整行拒绝但继续其他行；不删除、不取消 Run。Go 全量 **87/87**（含 PG16：投影写入、撤权 `entitlement_lost`、revision 回退不改事实、目录角色无表读权）。
- **HW-03 缺席与增量（2026-10-28 增补，John 选 A；Lily 复核见 §8）**：Work 增量 `0003_directory_absence` 新增 `work.directory_watermark(text)` 与 `work.mark_members_absent(text,text[],boolean)`（`SECURITY DEFINER`，仅 `work_directory` 有 `EXECUTE`；跨租户上下文拒绝）。函数对 `work.org` 行加锁并读取快照 revision，调用方不再传水位；`p_present_subjects` 上限 10,000；缺席只处理 `revision < snapshot` 的成员，置 `left`、撤 `work_seat`、`revision = snapshot`，写 `entitlement_lost` 审计。缺席数 ≥ max(10, 非 left 候选成员 20%) 时默认拦截：写 `directory.member_absence_blocked` 后返回 -1，不写入；需 `WORK_DIRECTORY_ALLOW_MASS_ABSENCE=1` 显式放行，放行写 `directory.member_absence_applied`。不取消 Run。Go 同步支持 `WORK_DIRECTORY_MODE=full|incremental`（默认 `full`）：incremental 用 `revision_after=watermark`，full 拉全量后按快照 revision 收窄缺席；成员失败/gap 不推进 org 水位，下一轮重试；新组织先以 revision 1 建行，成功后才推进到快照 revision；Host revision 回退拒绝（`host_revision_regressed`）。验证：Django **37/37**、Work pytest **42/42**（含 0003 回滚/重放）、Go **87/87**；负例矩阵见 §5。**残留**：失败/闸门拦截后的缺席重试依赖下一轮 full（值班补跑）；生产 Host 发布未执行，`realHostIntegrationVerified=false`；L1 已关闭，生产 CA/客户端证书未签发（见 §6）。

## 5. 负例验收矩阵（2026-10-28，本机/canary）

| ID | 场景 | 必须证明 | 状态/证据 |
|---|---|---|---|
| HW-N1 | 缺失/错名/重复 session cookie、伪造 cookie | 拒绝；不读取 body 中的 org/subject | **通过（本机）**：Django 12/12 覆盖缺失/错名/重复/空/伪造 cookie 与 body org/subject 忽略；Go API 错名/重复/空 cookie 3 子例拒绝且不调用 Host |
| HW-N2 | Host 不可用、超时、返回 5xx、缺字段、61s 过期、未来时间 | fail closed；不缓存正向结果；不降级放行 | **通过（本机）**：5xx/缺字段/61s/未来/超时 fail closed；两次调用两次 Host（不缓存） |
| HW-N3 | CSRF 缺失、别名头、错 token、cookie/header 不一致、过期、session_revision 变化 | 403 `csrf_invalid`；不产生副作用；单次刷新重试 | **部分/未触发**：token 签发/校验/过期/cookie 属性测试通过；尚无写端点消费 CSRF，别名头/副作用/刷新未触发 |
| HW-N4 | 客户端选 org、跨组织 org_id、未知组织 | `org_not_found`/拒绝；org 只来自 Host 会话 | **部分**：bootstrap org 只来自 Host 会话、body org/subject 被忽略；跨组织/未知 org 的 `org_not_found` 未触发（无客户端 org 输入） |
| HW-N5 | 低 revision、同 revision 异事实、全量缺席、operator_suspended | 单调推进、冲突拒绝、只收窄为 `left`、不取消 Run | **通过（本机 PG）**：低/同 revision、全量缺席、批量闸门、`operator_suspended` 保留；D1 smoke + directory tests |
| HW-N6 | 无客户端证书、错误 CA、错误 SAN、公网访问 | mTLS 握手/授权失败；内网端点不可从公网到达 | **部分**：Django 无证书/错 CA/错 CN/过期 403；canary 内网 30443 mTLS 200；公网 30443 关闭、生产 `/work-host` 未发布（公网访问未触发） |

## 6. 实施顺序与证据边界

1. Go `internal/host` HTTP client + wire 类型 + 本地 TLS stub 测试（不连接真实 Host）。
2. meet Host 端点 + mTLS 校验 + Host 侧负例。
3. `cmd/work-api` 的 `bootstrap` 纵切：会话验真 → RLS 上下文 → bootstrap → CSRF。
4. 真实 Host 联调与 HW-N1–N6 执行。

**本地 live 联调（2026-10-28）**：真实 Django Host 端点 + mTLS 代理 + 真实 meet/Work PG；full（org 1/成员 2）、incremental（仅 1 个变更成员）、硬删除缺席（`left`/撤座/`directory.member_absent` 审计）三场景通过；临时 CA/证书与 scratch DB 已清理。该证据不是 meet 集群部署。

**meet canary 联调（2026-10-28）**：以生产 `meet-backend:a34668295` 为基础做最小 overlay（OrgDiscovery 视图/模型字段/URL），部署独立 canary + 独立 `meet_work_host_canary` 库（克隆 schema + 测试 org）；ECS 经私网 `172.16.0.4:30443` 以临时客户端证书调用 `/work-host/v2/orgs` 返回 **200**，并从 `work_canary` 执行 full 同步（org 1/成员 2，投影/审计正确）。canary Deployment/Service/Ingress/Secret、canary 库、证书、节点镜像与 ECS hosts 映射已删除；生产 meet 工作负载/数据库未改，Host 端点未发布。该 canary 是 happy-path smoke，不是 release 级验收；HW-N1–N6 未执行。

生产发布已固化为 Helm：`workHost.enabled` 默认 false；启用后新增独立 `/work-host` mTLS Ingress + backend `WORK_HOST_MTLS_*`（CA 来自 `work-host-ca` Secret）；`helm template` 生产 values 验证通过。**生产前置**：平台创建 `work-host-ca` Secret（仅 CA 证书）并签发 CN=`work-control-plane` 客户端证书；客户端私钥只进 Work 控制面。未完成前不得启用 `workHost.enabled=true`。

本文是 **design_signed（John 主签 + Lily 安全复核，2026-10-28）**，不是 `realHostIntegrationVerified`；生产 meet 发布与生产级 HW-N1–N6 未执行（本机矩阵见 §5）。不得把本地 live/canary/stub 通过写成生产 Host 已发布。

## 7. 签收栏

| 项 | 结论 | 签字人 | 日期 | 边界 |
|---|---|---|---|---|
| HW-01–HW-04 | 通过（按推荐方案） | John Shao | 2026-10-28 | 仅 wire 与边界；不证明真实 Host/mTLS/CSRF 已实现 |
| HW-05 | 通过（改用 `sessionid` + session key 63-bit 哈希） | John Shao | 2026-10-28 | cookie 名勘误；`session_revision` 不是权限变更版本 |
| 安全复核（HW-01–HW-04） | 通过 | Lily Zhu | 2026-10-28 | mTLS、CSRF、fail-closed、cookie/日志脱敏 |
| 安全复核（HW-05） | 待办 | Lily Zhu | — | cookie 名勘误、session key 哈希语义 |
| 安全复核（新目录写入口 L1–L8） | L1–L8 通过（L2–L8 条件已落实） | Lily Zhu | 2026-10-28 | 见 §8；L1 证据已提交 |

## 8. Lily 复核：新目录写入口（2026-10-28）

范围：`directory_watermark`、`mark_members_absent` 及 Go 同步调用链；不重复 HW-01–04 的会话/mTLS/CSRF 复核。

| ID | 结论 | 条件/处置 |
|---|---|---|
| L1 权限与部署身份 | 通过（证据已提交 2026-10-28） | ECS 已建 `work_control_login`：`rolsuper=f/rolbypassrls=f/rolcanlogin=t`；成员仅自身 + `work_directory`；`work.member`/`work.org` 的 SELECT 均 false；函数 EXECUTE true；`SET ROLE work_directory` 成功、`SET ROLE work_owner` 被拒；直接读 `work.member` 为 42501。密码仅存 `/root/work-secrets.env` 的 `PG_WORK_DIRECTORY_PASSWORD` |
| L2 租户绑定 | 通过并补负例 | 已补 `directory_watermark`/`mark_members_absent` 的跨租户 `directory_org_context_mismatch` PG 负例 |
| L3 输入边界 | 有条件通过 → 已落实 | `p_present_subjects` 超过 10,000 个元素拒绝 `invalid_request:present_subjects`，并有负例 |
| L4 批量缺席爆炸半径 | 有条件通过 → 已落实 | 缺席数 ≥ max(10, 候选成员 20%) 时返回 -1、写 `directory.member_absence_blocked` 审计且不写入；需 `WORK_DIRECTORY_ALLOW_MASS_ABSENCE=1` 显式放行，放行写 `directory.member_absence_applied` |
| L5 单调性与竞态 | 通过 | 只处理 `revision < snapshot`；同/新 revision 不覆盖；PG 用例覆盖 equal/newer |
| L6 调用方水位权威 | 改为读组织水位 → 已落实 | 删除 `p_revision`；函数对 `work.org` 行加锁并读取当前 revision；签名改为 `(text,text[],boolean)` |
| L7 审计与可追溯 | 通过 | actor=NULL 与现有 `directory.*` 审计一致；metadata 含 revision/previous_status/work_seat_revoked/entitlement_lost；闸门拦截/放行各有 org 级审计 |
| L8 失败与部署 | 通过 | 失败/闸门拦截非零退出，下一轮必须 full 补跑；0003 先 apply 再启同步，回滚只停同步/删函数 |

**L1 证据（2026-10-28，已提交）**：ECS 上以 `work_control_login` 登录采集，结果如下；以下 SQL 可在部署时复现：

```sql
-- 以控制面登录执行
SELECT r.rolname FROM pg_roles r
 WHERE pg_has_role(current_user, r.oid, 'MEMBER') ORDER BY 1;
SELECT has_table_privilege(current_user, 'work.member', 'SELECT') AS member_select,
       has_table_privilege(current_user, 'work.org', 'SELECT') AS org_select;
```


实测：角色成员 `work_control_login` + `work_directory`；两个 `*_select` 均为 `f`；`mark_members_absent` EXECUTE 为 `t`；`SET ROLE work_directory` 成功、`SET ROLE work_owner` 被拒（`permission denied to set role "work_owner"`）；直接读 `work.member` 返回 42501。密码只存 `/root/work-secrets.env` 的 `PG_WORK_DIRECTORY_PASSWORD`；控制面部署必须使用该登录，不得改用 `work_owner`/迁移登录。



## 9. 生产后端发布（2026-10-28）

- **合并**：PR #10 以 rebase 合并到 `aliyun-dev`，merge HEAD `547f3bcb7dbf565bb0c05a76249e43a212890b46`；push 事件 [Release guard 40668936366](https://github.com/John-Shao/we-meet/actions/runs/40668936366) 通过（backend-boundaries/frontend-artifact/deployment-boundaries/desktop-boundaries 全绿）。
- **镜像**：`jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend:547f3bcb7`（由同一 tree 构建；`prometheus-client 0.24.1`、Django `manage.py check` 通过）。
- **运行面**：`meet-backend`、`meet-celery-backend`、`meet-celery-beat` 已滚动到 `547f3bcb7`；frontend/summary/agents 保持原 tag。发布脚本 `release-meet.sh backend` 退出 0。
- **数据层**：生产 DB 已建 7 个 NOLOGIN Work 角色；`core.0235_work_directory_fields` 与 `work.0001`–`0003` 已应用（`migration_0235=1`、`work` 86 个函数、3 个 `core_*directory*` 触发器）。首次发布前两次 Helm 失败分别为：Work 角色缺失、`meet` 无 `work_owner` 成员；均按 D-04 处理。
- **安全边界**：`workHost.enabled` 仍为 false；无 `/work-host` Ingress，`GET https://meet.we-meet.online/work-host/v2/orgs` 只返回前端 SPA fallback（`text/html`），Host API 未暴露。
- **未关闭**：生产 CA/`work-host-ca` Secret 与 CN=`work-control-plane` 客户端证书未创建；Work 控制面/`work-directory-sync` 未部署；生产负例矩阵未执行，`realHostIntegrationVerified=false`。
- **D-04 最小收口（2026-10-28）**：生产已建 `meet_migrator`（LOGIN，仅 `work_owner`）与 Secret `meet-migrator-db`；Helm 支持 `backend.migrate.envVars` 但生产暂不启用（`meet` 拥有 public 1257 个对象与 `django_migrations`，专用登录无法跑完整 Django migrate）。已 `REVOKE work_owner FROM meet`：运行时 `SET ROLE work_owner` 返回失败、`manage.py migrate` no-op 成功、服务健康。**未完成**：public 所有权拆分或 Work 迁移移出 Django；新增 `work.000N` 须 out-of-band 应用并补 Django 台账，详见 [迁移 Runbook §5](work-r0a-migration-runbook.md#5-生产-meet-库的-work-迁移2026-10-28)。
