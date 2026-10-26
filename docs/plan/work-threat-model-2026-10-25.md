# Work 威胁模型与供应商/价表核对清单

> 状态：草案，未完成正式安全评审，未完成供应商条款核对；不是生产安全证明。
>
> 日期：2026-10-25
>
> 基线：[Work 系统架构 v2.9](work-system-architecture-2026-10-25.md) §10–§18、§21；[DDL 草案](work-data-model-ddl-draft-2026-10-25.md)；[API/内部契约](work-api-contracts-2026-10-25.md)。

## 1. 范围与资产

保护对象：任务目标/来源摘录、连接器数据、模型凭据、设备目录与本地文件、成果正文、审批/预算/审计事实、设备私钥、运行沙箱与网关。

不覆盖：用户已完全控制的 OS、企业 EDR/设备管理、物理访问、供应商内部实现；这些是外部边界，不能声称由 Work 单独消除。

## 2. 信任边界

```text
浏览器/桌面渲染（不可信） 
  → Work API（会话/租户）
  → 控制面（Task/Run/审批/预算/成果/审计）
  → 编排 Worker（Temporal） 
  → 云端 Runtime（每 Run 隔离） / 设备 Agent（用户态后台）
  → 模型/连接器/工具受控出口
  → PostgreSQL / Content Store / KMS / 对象存储
```

- 模型、外部来源、连接器返回、工具参数都视为不可信数据，不是指令。
- Runtime 不持有长期供应商 Key；设备/本地目录许可不进入控制面绝对路径。
- 控制面与执行面、凭据域、内容域、观测域按安全边界拆网络与身份。

本轮新增两条边界（2026-10-26，控制见 S17/S18）：

- **B7 Host 目录 → Work 投影**：唯一的跨系统身份写入面。风险是伪造或重放目录事件提权（把 viewer 写成 admin、给离职者保留席位），或一个租户的适配器改写另一个租户的投影。
- **B8 管理面 → 审计导出文件**：风险是治理数据横向泄露，以及"下载入口一旦外流就长期可用"。导出正文属审计元数据聚合，仍然可能暴露谁在什么时候动了什么。

## 3. 威胁与控制

| 威胁 | 主要控制 | 证据/状态 |
|---|---|---|
| 提示注入诱导换工具/换目的地/扩 scope | 外部内容只作数据；工具目录、参数、资源范围与审批独立校验；模型输出不能授予权限 | 架构 §12.1/§17.1；F14/F25；切片 mock；真实模型注入测试未做 |
| 跨租户 IDOR/缓存泄漏 | 会话绑定租户、资源 ACL、复合 FK、RLS、对象/缓存 key 租户前缀、正文代理 | DDL RLS 冒烟（org1=1/org2=0）；切片 app 角色；生产连接池/运维角色未测 |
| 连接器粗 scope/资源越界 | Adapter 每次调用校验 grant status/revision、allowed_actions、resource_selector；不能隔离则拒绝 | 连接器切片 7/7；真实 OAuth/供应商 scope 未核对 |
| SSRF/DNS rebinding/跨域重定向 | 固定 API 目标、代理出口、允许列表、阻止内网/loopback、重定向与 DNS 复核 | S4 策略 23/23；真实网络适配器未测 |
| 模型/连接器凭据泄漏 | KMS 信封加密、独立凭据域、Gateway 注入、Runtime 无长期 Key、不记录正文 | 设计；KMS 层级/轮换/审计未实现 |
| 设备伪造/会话劫持 | 显式配对、OS 密钥库、mTLS、短租约、boot/session/fence、撤销 | 设计；本机切片使用 dev token/HTTP，真实 mTLS 未验证 |
| 宿主文件越界/TOCTOU | 句柄级 root、symlink/reparse 约束、类型化工具、Rust Broker、AppContainer/VM；H06 证明单层不足 | H06 部分通过；S2 F13 **失败**；Rust Broker 未实现 |
| 审批替换/重放 | 参数 hash、Run/fence、expiry、policy epoch、一次性消费、DB CAS | 切片覆盖 hash/revision；设备/云端完整消费路径部分 |
| 重复收费/重复外部副作用 | Operation ledger、unknown、provider 幂等/查询、预算预留、对账 | H04/H12/切片；真实供应商和 PostgreSQL 并发消费者未测 |
| 恶意 Markdown/Office/CSV | 禁止原始 HTML/脚本/外链资源；隔离转换、CSP、公式/宏策略、媒体类型校验 | 设计；R4a 转换器/预览未实现 |
| 供应链/安装包篡改 | 固定版本/digest、哈希校验、签名、依赖审查、受审核工具目录、升级准入 | H01 部分；可信 CA/EV、MSI/EXE、干净 VM 未做 |
| 管理员/服务方越权看正文 | 治理与内容读取分权、break-glass、审计、operator 停用上界 | 设计；管理端/审计导出未实现 |
| 离线/撤销延迟导致已发出动作 | 短租约、在线领许可、journal/receipt、unknown、不能宣称回滚外部请求 | 本机切片 8/8；真实设备/网络未测 |
| 备份/恢复旧快照复活撤权或重复术 | tombstone/撤权/删除与安全账本同一持久性边界；恢复后重放 tombstone 再开放 | S5 PG 10/10；DR 切换未演练 |
| 日志/事件泄漏正文或 reasoning | 事件只带公开事实/`content_ref`；trace 不含正文/路径/Key；reasoning 只留不透明引用 | 契约/事件 schema；切片事件无正文；生产日志审查未做 |
| 目录投影滞后或被伪造（撤权者仍能动、跨租户写席位/角色） | 投影只由 `work_directory` 经 `sync_org_projection`/`sync_member_projection` 写入；修订号必须单调；事务租户上下文必须等于目标组织；`operator_suspended` 不被目录覆盖；失权在 `create_input`/提交/重试即被拒；在途 Run 的停止属领域决定（D-07），适配器无权直接停 Run | D1 冒烟 113/113（投影 5 组负例）；host-ports 9/9；真实 P1-A 字段与同步频率未接（C31） |
| 治理读/审计导出跨租户泄露或下载入口外流 | 管理读仅 owner/admin 且绑组织；跨组织与不存在统一 404（不泄露存在性）；作业只含元数据不含正文；下载是一次性短期 token，只走 `X-Download-Token` 头（不进 URL/查询串），库内只存 SHA-256，兑换一次即失效；到期作业经 `content_shred` 清正文引用 | D1 冒烟 113/113（导出 11 组负例）；合同测试 10/10；`ci-contract` 禁 `download_url`；真实鉴权与访问日志扫描未做 |

## 4. 沙箱证明与边界

| 防护层 | 已验证 | 未证明/风险 |
|---|---|---|
| Windows AppContainer | 阻止授权外目录、用户目录、junction 目标与网络（H06） | 单独不阻止子进程创建；需叠加 Job/AppLocker/Node permission |
| Node `--permission` | 阻止 spawn/文件越界的一部分 | 单独可被 junction 绕过；不限制网络；不能当 OS 容器 |
| Rust Broker + 句柄级路径 | 设计目标 | **未实现/未验证**；S2 F13 失败 |
| gVisor/Kata/VM 云端隔离 | 设计目标 | 没有实际 sandbox profile/逃逸测试 |
| 设备私钥/OS 密钥库 | 设计目标 | 本机切片 dev token，不是真实配对/mTLS |

**结论：** 当前只能声明“分层控制设计 + 局部实验”，不能声明任意恶意本机代码或任意恶意 Office/HTML 在 Work 内安全。R0b 开放工具清单必须以 S2 的句柄级 Broker 和实际隔离 profile 通过为前提。

## 5. 供应商条款与资源授权核对清单

对每个模型/连接器供应商，商务与安全需共同确认：

| 项目 | 必须确认 |
|---|---|
| 数据用途 | 不用于训练/改进；子处理者与目的；opt-out/合同条款 |
| 留存与删除 | 请求/响应/日志留存期、删除 API、备份/子处理者删除、法务保留 |
| 区域与传输 | 驻留区域、跨境传输、灾备区域、模型路由是否可固定 |
| 资源 scope | OAuth scope 是否支持项目/空间/文件级；不支持则 adapter 必须拒绝虚假细粒度选项 |
| 凭证 | OAuth PKCE/refresh 轮换、撤销、权限提升重授权、API Key 轮换 |
| 幂等/查询 | 是否支持请求 ID/幂等键/结果查询；不支持时外部动作只能是 unknown |
| 限流/配额 | RPM/TPM/并发、重试/退避、供应商故障时的可用性 |
| 价格上界 | 输入/输出/reasoning/缓存/工具单价，`price_version`，最坏成本能否在预留上界内 |
| 审计 | 供应商侧审计日志、访问主体、导出与保留 |

当前状态：**未取得任何供应商书面条款/价表**；H02 只验证协议与 usage 字段，不是条款或计费承诺。风险登记中“供应商条款/连接器 scope”保持未关闭。

## 6. 价表与硬预算规则

- 金额用整数最小计费单位 + 币种 + `price_version`；不使用浮点累计。
- 每次调用前预留最坏成本：模型输入 tokens + `max_output`、工具时间/次数、连接器字节/分页上限；供应商无法给出可验证上界时不能宣传硬预算，必须明确接受有界超支或排除。
- usage 归一必须保留供应商原始字段（如 `reasoning_tokens`、缓存命中）但不得把正文写入 usage；价表变更产生新版本，历史结算不覆写。
- 账单差异通过 `adjust`/人工核对进入账本；不能静默改价或按“平均价”重算。
- 模型/连接器供应商的取消、超时、stream 断流、reasoning summary/encrypted_content 都要有 Operation 状态和费用处理规则。

## 7. 未决与关闭条件

- 正式威胁模型评审、滥用用例、沙箱逃逸/权限提升测试未做。
- Rust Broker/S2 F13、真实设备 mTLS/配对、真实连接器 OAuth/SSRF 未通过。
- 供应商条款、区域/留存/训练、价表上界未取得。
- KMS 密钥层级、轮换、crypto-shredding、备份恢复未设计到可实现级别。
- 关闭条件：安全评审签收 + 对应 F 用例/S 包通过 + 供应商书面材料 + 价表上界；本文不能替代任何一项。
