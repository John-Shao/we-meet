# Work R0b B03 对账载体设计（卡片 E=B 实施前置）

> 2026-11-10。卡片 E=B（保留本机推理、砍正文离机链）的实施前置：journal/seal/恢复通道中只为正文离机服务的部分砍掉后，B03（断线/撤权/unknown 不重放）用什么载体。本文是设计提案，供主签复核；不是实现，不改设计正文（正文修订属任务 #6），不开工设备面代码。引用以"文件＋章节/符号名"为准（J40=A）。

## 1. 问题

现设计的 B03 由六组机制承重：① 设备持久 journal（本机 §6.1 SQLite）；② lease/fence/session/generation（本机 §3.2/§3.3）；③ 服务端签署 `operation_resolution`（控制面 §6.4 第 6 步、`issue_operation_resolution`）；④ `finish_local_run_state` 收尾裁决（控制面 §6.4）；⑤ journal 清理水位＝`journal_release` 独立持久性 verifier ＋ `device_run_seal`/`run_sealed`（本机 §6.4、控制面 `issue_run_seal`/`consume_device_ack`）；⑥ 撤权后迟到回执经 recovery-only 通道上传（本机 §2.3、S14）。

卡片 E=B 砍掉正文离机链：S1 设备公网模型入口、S14 恢复通道、S15 云同步披露、`journal_release` 独立 verifier、`device_run_seal`、以及设备 CA/CN 白名单与设备签名证明中只为正文离机服务的部分。**①②③④ 是本机执行正确性＋控制面，保留；⑤⑥ 被砍，必须给替代载体**——这就是本提案要回答的。

## 2. 必须保留的不变量（架构 §3）

- **不变量 2（不重放）**：本机动作仅由 `authorized→dispatching` 单次 CAS 获胜者派发；设备持久 journal 以 Operation+request hash 去重；socket ACK/租约到期/进程被杀都不是未执行证明。→ 载体①②必须保留。
- **不变量 3（unknown 阻断）**：`unknown/unresolved` 保留配额与去重证据，阻断续跑/新 Run/采纳，只可对账。控制面强制点 `prepare_local_operation`/`consume_device_permit` 回 `run_has_unreconciled_operation`。两个无证据出口（只读 `evidence_unavailable`／副作用 `evidence_exhausted`）保留预留 `unknown`、不构成未执行证明。→ 载体③＋降级路径必须保留，且在 B 下更承重（恢复通道砍掉后它是撤权场景的唯一对账出口）。
- **不变量 4（隔离独立）**：目录许可重启/登录变化失效；lease/fence、device session、global recovery generation 独立。重启先核对旧日志再重新授权。→ 载体②保留。

## 3. 载体设计

### 3.1 保留不动（本机＋控制面）

| 机制 | 落点 | B 下的状态 |
|---|---|---|
| 设备 journal（action_journal 去重、receipt_outbox、checkpoint、runtime_start/finish、local_content） | 本机 §6.1 | 保留，仍 DPAPI-DEK 加密。`local_content.sync状态` 列随云同步砍掉而失效（留列不写或随 #6 删）；`clipboard_derived`/classification 仍服务本机 local_only 闸 |
| lease/fence/session/generation、SignedPermit | 本机 §3.2/§3.3 | 保留。permit `aud` 闭集去掉 `device-egress`（S1 砍），剩 `device-tool`／`device-model-proxy`（device_local）。J12 的"只为交回历史＋收尾"lease 保留（零新许可） |
| `operation_resolution`（服务端签署、单调 revision、ack 不阻塞收尾） | 控制面 §6.4 第 6 步、`issue_operation_resolution`（0021 已实现） | 保留，是设备 journal 离开 unknown 的唯一途径 |
| `finish_local_run_state`（本 Run 门槛、final_operation_set_hash、checkpoint 连续性、terminal_run_revision） | 控制面 §6.4 | 保留 |
| 降级路径 `evidence_unavailable`（只读）／`evidence_exhausted`（副作用，J38） | 控制面 §4.2/§6.2（0021 已实现） | 保留，B 下更承重 |
| 撤权流水线（deny＋access_epoch＋cancellation_intent＋消费者） | 控制面 §6.1（0019/0023，消费者 #32 待实现） | 保留，服务端拒新 lease/permit |
| 设备身份（gateway 连接）＋ receipt 签名＋ `PossessionProof(accept)` | 本机 §2/§7.3 | 保留（B 未选 C，不削弱设备身份核心）。CN 白名单去掉 egress/recovery 入口，只剩 device-gateway |

### 3.2 替代载体一：journal 清理水位（替换 journal_release ＋ device_run_seal）

**原机制**：`journal_release` 由独立 verifier 证明同步副本 flush 到某 WAL LSN 后签 `through_seq`，设备据此清 receipt_outbox；`run_sealed` 在 Run 终态＋全部 receipts durable-recognized 后签发，设备据此清 action_journal 去重 tombstone。独立 verifier（J24/S8）与 seal 帧/ack 是重头。

**B 下的替代**：没有云同步副本边界，持久性边界就是控制面 PG 事务提交本身。清理水位改由**两个已存在的签署事实**驱动，不新建独立 verifier、不新建 seal 帧：

- **receipt 增量清理** ← `checkpoint_commit` 的 `recorded` ack 所携带的 receipt 水位（控制面 §3.4 已记录"receipt 水位"）。该 ack 只在控制面事务提交后签发，故"已 recorded"即"已持久"，无需另证副本 LSN。设备释放 ≤ 该水位的连续 receipt seq。
- **tombstone 清理** ← `finish_local_run_state` 的 `accepted` ack（携带 `terminal_run_revision`，且已校验 `final_operation_set_hash` 与 `receipt_through_seq` 连续）＋本 Run 每个 Operation 的 `operation_resolution` 已收到。Run 终态成立且全部 Operation 已服务端定论后，设备清去重 tombstone。`run_sealed` 帧取消，其语义并入 finish ack。
- **ack 永不阻塞**（保留）：未确认的 resolution 每次 session 建立重推；设备不 ack 不影响服务端结论；撤权/永久失联时服务端仍完成账本与 tombstone。`consume_device_ack` 从三类 ack（resolution/journal_release/run_sealed）缩到一个（resolution）。

**为什么安全**：清理的两个驱动事实都是服务端签署、单调、事务提交后才发出的；设备不凭本地推断清理。不变量 2 的去重 tombstone 留到 Run 终态＋全 Operation 定论，与原 run_sealed 的门槛等价，只是载体从独立 seal 帧换成已有的 finish ack＋resolution。磁盘上限（256MiB/空闲 512MiB 停新 Run）保留；本机 Run 有界（3600s、≤20 成果），journal 增长可控。

### 3.3 替代载体二：撤权后迟到回执（替换 S14 recovery 通道）

**原机制**：撤权设备经 recovery-only 通道（历史公钥验签、不要求有效客户端证书）上传撤权前已 FULL commit 的历史签名 receipt。

**B 下的替代**：恢复通道砍掉，撤权设备的迟到回执**不再被接受**。对账改由服务端权威事实独立完成：

- 撤权前已上传并 recorded 的 receipt → 正常核账结算。
- 撤权前已 dispatch 但 receipt 未上传的 unknown → 服务端按 gate 事实（`dispatch_delivery`：是否 dispatch、`sealed_not_sent`、`receipt_recorded`）裁决；无证据时走降级：只读类 `evidence_unavailable`、副作用类 `evidence_exhausted`（需外部可见工单、采纳仍 `acceptance_blocked_unresolvable` 拒、预留保持 unknown）。
- Run 由控制面单方 `finish_local_run_state(failed, input_missing)` 收口（J34/R12C-7 已有此口径）。
- 本机成果仍在原设备：用户本地查看/导出照常（本机 §7.3 本地 ACL＋账号密钥＋tombstone 后 24h 宽限），不需要控制面票据，也不借任何通道导出正文。

**已接受代价（须主签确认）**：撤权前已在本地完成但 receipt 从未上传的动作，服务端无法确认 → 降级而非结算（预留保持 unknown，副作用类采纳被锁）。对本机-only 执行这是可接受的：成果在本地用户手里，服务端缺的只是用量确认；device_local 模型用量若回执未上传则不计量、预留挂 unknown，由降级路径处置。**不存在"设备想要核账就补签成功"**（不变量 2 保留）。

### 3.4 设备签名证明的取舍（逐件枚举，供主签确认"三类"所指）

| 证明 | 用途 | B 下 |
|---|---|---|
| `SupersedeAssertion`（本机 §3.5） | 取代可归责 | 保留（本机工具取代） |
| `GrantSuccessionProof`（本机 §3.5） | 同目录改绑 | 保留 |
| `UserVersionProof`（本机 §7.5） | 用户编辑保存本机版本 | 保留（本机成果） |
| `PossessionProof(accept)`（本机 §7.3） | 本机采纳 | 保留 |
| `PossessionProof(restore/read_ticket/sync)` | 跨设备恢复/读取/同步 | 砍（正文不离机，无跨设备读取） |
| `DisclosureDecisionProof`（本机 §7.4） | 云同步披露 | 砍（S15） |
| 三个 ack 帧 | resolution/journal_release/run_sealed | 缩到 resolution 一个 |

设备 CA＋CNG 签名键保留（gateway 认证＋receipt 签名＋accept 证明），CN 白名单只剩 device-gateway。**若主签想进一步削弱设备身份（换 Host 会话设备 token），那是选项 C 的范围，须另行裁定，不在 B 内默认发生。**

## 4. 连带设计修订清单（任务 #6 执行，本文不改动正文）

- 本机 §2.3（recovery-only）整节删除/标移出本期；§3.3 permit `aud` 去 `device-egress`；§3.4 收尾第 4 步"journal_release/run_sealed"改"finish ack＋resolution 水位"；§6.4 重写（清理水位替代）；§7.4 云同步整节移出；§7.2/§7.3 跨设备恢复读取移出、本机采纳保留；§8 支持包边界不变（本就禁止 local_only 正文外发）。
- 控制面 §1.3 `PossessionProof` purpose 闭集去 restore/read_ticket/sync；§1.4 去 device-recovery/disclosure-decisions/syncs 端点；§4.1 `device_run_seal`/`disclosure_decision`/`artifact_replica`(cloud) 表移出；§4.2 `issue_run_seal` 移出、`consume_device_ack` 缩到 resolution；§6.4 第 6 步清理水位口径改写；§7.2 同步状态机移出。
- 架构 B01–B10 范围（B04 移出、B09 远程部分移出）、不变量 8（journal_release 持久性）改写为"清理水位由 finish ack＋resolution 驱动"、RB-A12/RB-A21 相应调整。
- 签收单 S 集合：S1/S14/S15 移出本期，J39 审计必读最小集六→三（S2/S4/S11）；S8 部署面去掉 egress/recovery 入口与 journal_release verifier 项。
- 体验 §8 排程与 EV 归属（见 §5）。

## 5. EV 影响（标记，供 #6 改写）

- **砍**：EV95（recovery 通道）、EV51（recovery 限流）、EV63/EV107（device egress 入口）、EV116/EV123 的 sync 腿。
- **改写**：EV100（去 recovery-only 腿、ack 缩到 resolution）、EV115（seal 三类 ack 水位 → finish ack＋resolution 水位）、EV102/EV114（device_local 保留、device-egress 去）、EV97/EV98（classification 本机闸保留、sync 路径去）、EV121（分类下限预览告知保留）。
- **保留且更承重**：EV80（operation_resolution）、EV113（收尾期零新许可）、EV120（evidence_unavailable/exhausted 双向）、EV70/EV71（审批/取代）。

## 6. 待主签复核的决策点

1. **清理水位替代**（§3.2）：finish ack＋resolution 替换 journal_release＋run_seal，不建独立 verifier。**推荐采纳**；备选＝保留一个轻量 seal 帧（增加一帧一 ack，无独立 verifier）。
2. **撤权迟到回执代价**（§3.3）：不接受 → 降级而非结算，本机成果仍可本地查看/导出。**推荐采纳**（与 J38 降级同向）；备选＝保留一个极窄的"撤权前历史 receipt 上传"口（那等于恢复 S14 的一半，与 B 砍恢复通道相冲，不建议）。
3. **设备身份核心保留**（§3.4）：B 保留设备 CA＋CNG 签名（gateway/receipt/accept），只砍跨设备证明与 egress/recovery 入口。确认"三类设备签名证明"所指与本文枚举一致；若要削弱身份核心，转选项 C 另行裁定。
4. **device_local 用量计量**：回执未上传（撤权）时不计量、预留挂 unknown 走降级。确认此口径。

**【2026-11-10 主签复核：采纳，四点按推荐】** 主签逐项单选采纳本载体设计，§6 四个决策点全部按推荐落定：① 清理水位由 finish ack＋resolution 驱动（不建独立 verifier/seal 帧）；② 撤权迟到回执不接受、走降级路径（已接受"降级而非结算"代价）；③ 设备身份核心保留（CA＋CNG 用于 gateway/receipt/accept），"三类设备签名证明"按 §3.4 枚举砍跨设备证明＋`DisclosureDecisionProof`；④ device_local 用量回执未上传时挂 unknown 走降级。**7 日延迟复评窗 2026-11-17**。本提案据此成为 B03 载体的规范输入；设计正文修订（§4 清单）与 EV 改写（§5）由任务 #6 执行，传播扫后复跑文档门禁。本文未经外部独立安全复核，不得称"经独立复核/审计通过"。

## 7. 边界

- 本文是设计提案，未经外部独立安全复核，不得称"经独立复核/审计通过"；主签复核后写下结论起 **7 日延迟复评**。
- 复核通过前不修订设计正文（#6）、不开工设备面代码。复核通过后 #6 按 §4 清单修订正文并做传播扫（runbook/演练/README），改后复跑文档门禁。
- 与 J40=A（任务 #4）、J41/J42/#32/#43/#44 正交，这些照常推进。