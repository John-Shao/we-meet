# 通话采样派发恢复与运行状态走查

日期：2026-10-11（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。

继续 Qwen 优先，功能默认关闭。本轮使用隔离 PostgreSQL／Redis、模拟 LiveKit RPC、合成 SDK 音频帧与本地 HTTP；没有真人采样、收费 ASR 或生产部署。

## 发现与修复

| 问题 | 修复与验证方式 |
|---|---|
| 事务提交后的队列消息失败会丢失采样启动请求 | 在本人声明／可信来源事务内写入 `VoiceprintSamplingDispatch`；提交后队列消息只负责唤醒。消息失败保留意图，周期恢复；事务回滚不保留意图、不发送消息 |
| 派发 RPC 跨越会话锁与来源游标，阻塞会话关闭 | 短事务领取 15 秒租约，事务外调用 LiveKit，短事务复核当前来源并提交。双数据库连接验证 RPC 期间可取得会话锁并结束会议，结束状态优先于迟到成功 |
| 重复任务、进程中断及远端已创建但关闭客户端失败 | 同会话有效租约只允许一个派发；过期租约可恢复，旧 token 完成不能覆盖新结果；重新查询相同 room SID／agent／metadata 的 pending、running 或尚无 job 的 dispatch，避免重复创建 |
| 派发失败、新声明及旧声明的恢复缺口 | 失败间隔 10、20、40、80、160、300 秒并封顶；RPC 期间 revision 变化立即重新检查；新声明重开终态意图。周期扫描有显式非共享设备声明但缺少意图的活动会话，兼容升级前／开关启用前的声明；仍须通过当前授权、MIC 与配额检查才调用 RPC |
| LiveKit 暂时查不到房间就永久停止恢复 | 本地会话仍 active 时转为 idle 并重试；本地会话已结束才成为永久 ended。忙碌会话延后再检查，使其轮转到其他到期意图之后 |
| “允许采样”、已发许可或 worker 已启动可能被误认为实际采样 | 保留原连接控制状态，新增仅本人可读的 `runtime`。未报告状态为 waiting／starting；只有当前许可绑定的有效采样报告才显示 sampling，上传为 uploading；5 秒未更新即失效 |
| 迟到、重复、倒序和结束后的报告改变显示状态 | 报告同时携带 phase 与严格整数 sequence，复用独立 sampler 凭据、许可 HMAC 和精确 RTC 来源验证。旧 sequence 不改阶段、不续期；阶段按 waiting → sampling → uploading → stopped 的顺序不回退，以 waiting 开始，允许提前 stopped，同许可 stopped 后不能重新 sampling |
| 暂停／共享声明、授权 generation、设备组、参与者／房间／轨道变化后仍显示旧采样 | 每次本人查询复核当前许可、版本、generation 撤销下限、设备组及来源。暂停、配额、MIC 不可用等有固定原因。最后一条已合法预留的片段仍可上报，之后不能再取得超额许可 |
| 许可发放与上报／入库的组织锁顺序不同 | 发放时先取得 owner／organization，再取得 session／track，避免另一人在同房间持有 organization 后等待 session 的死锁。双连接测试验证等待组织锁时未占有会话锁 |
| 清理短期上报行过早会丢失防重放阶段／序号 | 心跳失效后先停止展示；维护任务须同时满足许可到期或许可已不存在才删除上报行。在 track 锁内复核，保留终态与序号直到原许可不能继续报告 |

agent 收到通过格式检查的第一帧 PCM 才切换 sampling；创建订阅或 stream 不算采样。关闭订阅与 stream 后才上报 uploading；擦除缓冲后上报 stopped。上报失权／超时仍沿用整段丢弃规则，不阻塞帧接收，不把音频、标签、token 或原异常写入日志。

## 调度与兼容

- 迁移 `0217_voiceprint_dispatch_activity` 新增派发租约和短期上报两张表，不迁移音频或向量。
- `core.tasks.voiceprint_sampling.recover_voiceprint_samplers` 每 15 秒投递到独立 `voiceprint` 队列，消息过期 30 秒；每次至多补齐 20 个缺失意图并处理 20 个到期意图，最大配置限制为 100。
- 可运行 `dispatch_voiceprint_samplers --limit 20` 手工恢复；返回固定计数，不含身份／音频／凭据。
- 上报复用 `POST /api/agent/voiceprint-sampling/permits/{id}/validate/`，可选字段必须成对传入：`activity_phase`、`activity_sequence`。验证成功的原 grant 响应不变，旧调用仍可只验证授权。
- 本人 `sampling-control` 增加 `runtime.state/reason/updated_at`；就绪时提供 `remaining_ms.session_ms/daily_ms`，不暴露许可、nonce、profile 或声音身份。
- 周期维护新增独立有界的 activity 类别，每类别至多 20 行、四类合计最多 80 行；默认上限 100 时最多 400 行。来源／track 删除仍通过 FK 清除相关状态。

## 验证与边界

新增后端专项 43 项，覆盖持久意图、事务回滚、重复租约、过期恢复、丢失确认、重试退避、旧声明补齐、忙碌轮转、锁并发、私有状态、重放、阶段回退、源变化、配额与清理。agent 原 12 项加 4 项专项，共 16 项通过（5.213 秒），验证真实 SDK 合成帧、订阅关闭、缓冲擦除、HTTP 边界与许可契约。

657 项后端组合回归全部通过（368.40 秒），包含新增 43 项与原登记、通话、候选、模板、授权、来源清理及会议记录生命周期用例。迁移在两个隔离数据库应用成功；Django 检查无问题、无迁移漂移，变更模块 Ruff／格式及暂存差异检查通过，旧模型九项 lint 基线未扩大。当前生产未部署这些表、Beat 配置和 worker。

该阶段为 Web／Android 通话告知、声明与暂停界面提供后端状态契约，不等于两端界面已交付，也不证明真实会议音轨、云端 Qwen 质检效果、真人实名匹配质量或生产容量。完整 RTC 联调、跨端入口、部署／监控、可信外部备份恢复与获授权真人验收继续推进。
