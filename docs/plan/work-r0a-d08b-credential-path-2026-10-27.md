# D-08b 签收清单（网关取凭证 / Key 托管 / 静态密钥）

> 状态：**2026-10-27 会前确认，B2/B6 已按静态模式改写**。D-08b 拟在 **DR0 2026-11-03** 由安全 + 平台按 (a)/(b) 签收；它只解冻 **D4 网关取凭证与 D6/S14** 的设计回写，**不关闭 C04**。2026-10-27 决定：演示组织用 A managed_key；D-03 改 B 静态单层加密，B1/B3/B4/B5/B7–B10 沿用通过，**B2/B6 已重写，随 DR0 签修订版**。
>
> 范围：D-08 §1 第 4 项 + R7（Key 托管）+ R8（吊销语义）；不含 D-08c（配额）、D-08d（管理台写/R9/R10）。
> 相关：[D-08 决策单 §6](work-r0a-provider-account-metering-decision-2026-10-26.md)、[D4 出口设计](work-r0a-runtime-egress-design-2026-10-25.md)、[D6 S14](work-r0a-security-ops-migration-design-2026-10-25.md)、[签收单 R0-c](work-r0a-dr0-dr1-signoff-2026-10-26.md)。

## 0. 边界：D-08b ≠ C04

| 项 | D-08b（DR0） | C04（DR2 11-17） |
|---|---|---|
| 签什么 | 凭证形态、静态密钥、网关取凭证、吊销/轮换、脱敏与审计的设计口径 | D4 Runtime/出口整体评审（沙箱、egress、Adapter、静态密钥/Content Store 边界） |
| 证据 | D1/D2 设计资产：143/143（含 D-08 25 项与静态凭证 4 项）、9/9 竞态、34/34 契约、mock writeOnly | 需要 D4 设计复核 + C14 降级 + 真实沙箱/出口证据 |
| 签后能做什么 | 改 D4 §10、D6 S14；E5 可按该口径排期 | 仍不能开工 E5；C04 未签 |

**D-08b 签了也不等于 C04 签了；C04 仍在 DR2。**

## 1. 需签的设计口径（逐条）

| ID | 口径 | 当前设计/证据 | 还缺什么 | 不签的后果 |
|---|---|---|---|---|
| B1 | **凭证形态按厂商分叉**：阿里云/火山走客户授权角色 + STS；DeepSeek 无跨账号角色，走平台托管 Key（客户自建代理为可选备选） | D-08 §1 第 4 项；D1 表 `mode IN ('sts_role','managed_key')`；D2 create/rotate 请求区分两种模式 | 客户阿里云/火山的角色 ARN/委派方式由客户提供；演示组织已选 A managed_key | 网关只能按“平台持有全部 Key”旧假设，D4 无法写取凭证路径 |
| B2 | **静态单层加密（D-03 B）**：全局主密钥放进程 Secret，按 `org_id` 派生每组织密钥；只存密文 + 指纹 + `key_version`，不存 wrapped DEK；`wrapped_dek`/`kms_key_ref` 允许 NULL，留作未来 KMS | D1 `provider_credential` 现有 `secret_ciphertext`/`secret_fingerprint`/`key_version`；`wrapped_dek`/`kms_key_ref` 作未来预留；D1 CHECK/函数已放宽（143/143 已复跑） | 主密钥托管位置与访问审计、派生参数（HKDF/salt）、手工轮换演练；真实 KMS/HSM 不在 R0a | D6/S14 无“托管客户密钥”基线；主密钥泄露影响按组织派生范围 |
| B3 | **只写不回读**：API 只回指纹/后四位与 key_version；应用与 worker 对凭证表无直接 SELECT；网关只能经 `resolve_provider_context` 取密文 | D1 权限：`REVOKE SELECT ON provider_credential, provider_access_config`；`resolve_provider_context` 只给 worker；D2 `api_key` writeOnly；mock 断言响应不含明文 | 真实网关解密路径与主密钥访问边界；日志/trace 的负例需在 E5 用真实探针复验 | 平台管理员可能读到明文；客户不敢托管 Key |
| B4 | **按组织隔离**：每组织一条 active 接入配置；网关只取本组织配置与凭证；跨组织写在数据层不可见 | D1 部分唯一索引 + RLS + `resolve_provider_context(p_org_id)`；冒烟 `provider_config_not_shared_across_orgs`；竞态 9/9 | 真实多副本网关的缓存隔离；跨组织审计导出边界 | “演示组织配置不共享”只是口头承诺 |
| B5 | **吊销即生效**：吊销凭证/配置对新调用立即失败；在途调用以受控错误结束，不静默换凭证重试；Run 可重投 | D1 `revoke_provider_credential`/`revoke_provider_config`；冒烟 `credential_revoke_blocks_new_calls`、`provider_config_revoke_stops_calls`；D4 设计“失败进 unknown/对账” | 真实在途调用与 provider 回执；D6 告警与客户通知时限 | 吊销后仍可能用旧 Key 跑完在途 Run；客户账单不受控 |
| B6 | **轮换（静态主密钥）**：`key_version` 单调递增，旧版本不可再取；主密钥版本轮换时按 `key_version` 重加密或双版本读；轮换后新调用立即用新版本 | D1 `rotate_provider_credential` 校验 active/managed_key；D2 rotate 接口；mock key_version 2 | 主密钥版本与 `key_version` 的映射、全量重加密窗口、轮换演练；无 KMS 自动轮换 | 旧 Key 泄露无法快速切换；版本不可追溯 |
| B7 | **强审计**：创建/轮换/吊销/调用失败都记审计（操作人、组织、时间、旧/新版本、指纹），不含明文 | D1 `append_audit`（`provider.credential_created/rotated/revoked`、`provider.config_changed/revoked`）；冒烟断言审计无密文 | 真实审计导出与保留 365 天；S14 日志扫描 | 无法证明“谁在何时换了哪把 Key” |
| B8 | **unknown 对账用客户凭证**：Operation unknown 时，用该组织当前凭证查上游；不得用平台兜底 Key | D4 设计原则；D1 `reconcile_operation` 记录 `provider_request_id`；D-08 §4 新增要求 | 真实上游查询接口与客户授权；凭证吊销后的对账行为 | unknown 永远无法确认，预留/成本悬空 |
| B9 | **密钥泄露应急**：批量吊销、客户通知、审计与轮换演练；D6 告警 | D6 S14 扩项待写；运行手册应急章节待补 | 应急流程、通知时限、演练 | 泄露时只能手工逐个吊销，无证据链 |
| B10 | **脱敏负例**：日志/trace/错误体/审计不含明文或密文；只允许指纹 | D4 日志策略 + 8/8 log scan；D1 审计负例 | 真实 OTel/日志后端扫描；E5 合成密钥探针 | 一次错误日志就把客户 Key 写进日志 |

## 2. 唯一需要产品/平台现在定的参数

**演示组织（百炼）的凭证模式**：**2026-10-27 已选 A managed_key**。

| 选项 | 含义 | 代价 |
|---|---|---|
| **A. managed_key（已选）** | 我们用自己申请的百炼 API Key，静态单层加密托管；演示数据 | 与 C15 waived 一致；主密钥放进程 Secret，按组织派生；无 KMS/HSM 审计，手工轮换 |
| B. sts_role | 若百炼支持 RAM 角色委派，用短期角色 | 需要确认百炼是否支持；平台角色配置更复杂 |
| C. 客户代理 | 演示组织自建代理，平台只存 endpoint | 演示环境多一个组件，无必要 |

客户组织：阿里云/火山按其角色能力走 STS；DeepSeek 走 managed_key（或客户自建代理，作为接入说明的条件备选，不纳入 R0a 实现）。

## 3. 证据边界（签收前必须一起读）

- **已证**：D1 数据层 143/143（D-08 25 项：密文/指纹/吊销/跨组织/越权/用量；D-03 B 4 项：静态创建/轮换、KMS 成对、resolve 静态）；9/9 竞态（配置并发写、用量累加）；D2 34/34（writeOnly、版本冲突、owner-only、吊销）；本地 KMS envelope 6/6 是历史参考，**D-03 改静态密钥后不再作为本单证据**。
- **未证**：静态主密钥的托管/派生/轮换、STS 换取、百炼 Key 的真实调用与吊销、在途调用吊销、客户通知、真实 OTel 脱敏。**D-08b 签的是设计口径，不是生产实现。**
- **D1 修订**：`provider_credential` 的 CHECK 与 create/rotate 函数已允许 `wrapped_dek`/`kms_key_ref` 为 NULL；静态模式只要求 `secret_ciphertext`/`secret_fingerprint`/`key_version`。已复跑 143 项冒烟与 9 组竞态。
- **不构成 C04 或 C14 的证据**；C04 仍按 DR2 签，C14 的降级另签。

## 4. DR0 签收表

结论栏三选一：通过 / 通过并附修订 / 退回。签字人安全 + 平台（当前同一人，走 (b) 自证；DR3 前补独立复核）。

**2026-10-27 会前确认**：B1/B3/B4/B5/B7–B10 通过；B2/B6 按“静态单层加密 + 主密钥派生/轮换”改写后通过；演示组织模式 A。DR0 会上填正式勾选框与真名，独立复核人 Lily Zhu（覆盖全部关键项）的复核记录同日归档。

| ID | 结论栏 | 签字人（真名） | 日期 | 备注 |
|---|---|---|---|---|
| B1–B4 凭证形态、静态加密、只写、隔离 | □通过 □附修订：____ □退回 | 安全 John Shao + 平台 John Shao | 2026-11-03 | 演示组织 A；B2 已按静态模式改写 |
| B5–B7 吊销、轮换、审计 | □通过 □附修订：____ □退回 | 安全 John Shao + 平台 John Shao | 2026-11-03 | B6 已按静态主密钥轮换改写；吊销在途语义以 D4 unknown 为准 |
| B8–B10 对账、泄露应急、脱敏 | □通过 □附修订：____ □退回 | 安全 John Shao + 平台 John Shao | 2026-11-03 | 泄露演练列入 E5 |

## 5. 签后回写

| 位置 | 写什么 | 时限 |
|---|---|---|
| D4 §10 | 网关按组织取凭证（STS 换取 / 静态主密钥解密）；unknown 用该组织凭证 | D-08b 签后 2 个工作日 |
| D6 S14 / `security-controls.json` | 托管客户密钥控制项、主密钥派生/轮换与使用失败审计、告警 | DR2 前 |
| `work-r0a-security-ops-migration-design-2026-10-25.md` | 密钥泄露应急与通知时限 | DR3 前 |
| work-project §4.4/§9 | D-08b 结论与 C04 状态（C04 仍待 DR2） | 签后 24 小时 |

## 6. 不解决

- 不关闭 C04、C14、C25；D2 不改，**D1 仅做静态模式最小修订**（KMS 字段允许 NULL），C01 在 DR1 记“通过并附修订”。
- 不提供真实 KMS/STS 证据；静态主密钥托管/轮换与 E5 实现必须补。
- 不替代 D-08d（管理台写权限/R9）与 D-08c（配额/可见性）；它们分别随 DR0/DR1 签。
