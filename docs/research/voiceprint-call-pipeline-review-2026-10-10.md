# 通话采样 agent、候选入库与独立质检

日期：2026-10-10（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。

在[采样许可基础](voiceprint-call-sampling-review-2026-10-10.md)上接通独立 sampler、后端派发、一次性加密候选入库、编码和通话单人质检。默认关闭，没有部署服务、连接实际会议、采集真人声音或调用付费 ASR。模型路线仍为 Qwen 优先。本阶段接通本人审核；后续[设备组模板走查](voiceprint-device-templates-review-2026-10-10.md)进一步接通经本人确认的通话贡献、首次基准、跨会话补充与失效重建，单个候选确认仍不等于模板已具备全部构建条件。

## 链路与边界

1. 本人连接声明变为可申请，或收到已验证的轨道发布 webhook 后，提交后再调度独立 Celery task。任务检查有效连接、本人授权及设备声明，核对 LiveKit 真实房间 SID，复用同场未结束的派发任务。关闭功能、旧房间、暂停、共享设备、agent 或失效身份不会派发。派发只携带房间实例引用，不包含用户配置、密钥或授权真值；worker 仍须逐轨取得后端许可。Celery 的固定错误可重试，task 已在包入口注册。
2. `entrypoints.voiceprint_sampler` 为独立进程，参与者可见，禁止发布音频和数据，连接时 `SUBSCRIBE_NONE`。遍历人的麦克风元数据并轮转，只有取得精确许可后才订阅；每进程同时最多一条音轨。轮转无前 128 人截断，其他来源没有单独音频缓冲。空闲 30 秒退出，房间断开时结束。
3. `AudioStream` 明确设置 24 kHz、单声道、20 ms 帧及 8 帧容量。已探测的 SDK `RingQueue` 会静默丢弃最旧帧，因此用相同 `put/get` 协议的有界队列记录溢出；溢出整段拒绝，不拼接缺帧。适配涉及 SDK 私有队列，需要 SDK 升级时重跑原生回归。当前实际版本与 `uv.lock` 一致：`livekit 1.1.2`、`livekit-agents 1.4.5`。
4. 每段最多 10 秒、480,000 字节 PCM，SDK 队列之外只维护当前片段。每 0.5 秒重新检查连接并复验后端许可；单次内部 HTTP 总期限 2 秒，许可复验失败停止并丢弃片段。生成 WAV 后、上传前再次检查，先退订再交付。取消、静音、替换参与者／轨道、超时、非法帧和溢出均阻断上传。覆盖并释放 sampler 自己的 PCM/WAV 可变缓冲；不承诺擦除 SDK、TLS 或操作系统的全部内部副本。
5. 新私有 `PUT /api/agent/voiceprint-sampling/permits/<id>/clip/` 只接收带 Content-Length 的短 WAV 二进制，使用独立 sampler 凭证及许可 token，不接受音频 URL、owner、组织或质量覆写。限制正文和来源参数，按用户、组织／授权、会议实例、轨道和许可锁顺序重验，原子链接已消费许可、加密样本及编码任务。相同许可和规范化 PCM 重试返回同一候选；不同内容、超额音频、重复样本及撤权后的迟到上传均拒绝，不留下部分任务。
6. 编码后进入既有独立质检队列。通话没有随机朗读提示，因此走现有可终止短 ASR 子进程的单人查询质检，核对音频摘要、模型、策略及有效语音量；再将来源绑定证据封入加密特征。使用独立 `qwen-short-asr-call-v1` 样本策略，与登记提示语证明分开。未通过质检不能确认；通过后也必须本人决定，积累授权不授予登记确认权。
7. 明显多人结果拒绝并清除候选音频和特征，暂停对应声明 revision，保存 `stop_reason=mixed_speaker`，取消同 revision 未消费许可。用户重新声明设备后，旧片段的迟到质检结果不会误暂停新声明。普通会议结束／暂停不抹去已合法采集的待审核候选，当前授权及可信回执仍须有效。

内部传输使用明确依赖并冻结的 `aiohttp 3.13.5`；关闭重定向、代理环境、Cookie 和自动解压，限制响应字节及整个请求时间，不留下 `to_thread` 后台读取。依据与上限机制见 [aiohttp ClientTimeout](https://docs.aiohttp.org/en/stable/client_reference.html#aiohttp.ClientTimeout)、[LiveKit AudioStream](https://docs.livekit.io/reference/python/livekit/rtc/audio_stream.html)及[选择性订阅](https://docs.livekit.io/transport/media/subscribe/)。实际安装版本和原生 SDK 测试为本项目兼容性证据。

## 验证

- 402 项后端回归通过（118.21 秒），覆盖授权、采样许可、一次性入库、登记／本人决定、模板、状态、编码／质检、webhook 和会议生命周期；采样入库专项 18 项，派发专项 11 项。取消记录列表截断后的派发专项 11 项再次通过，结果不相加。
- 43 项 agent 回归通过（11.481 秒），包含新 sampler、现有入口、翻译／同传控制。新 sampler 覆盖真实 SDK `AudioFrame` 内存布局、原生 FFI 合成音轨、准确 3 秒／72,000 PCM 样本 WAV、退订／关闭、取消／撤权、不获许可不订阅、溢出拒绝、同请求重试、140 人轮转及本地 TCP 的慢响应／重定向／压缩／超大响应。
- 后端质检专项通过真实子进程和本地模拟短 ASR HTTP 服务验证通话路径；只使用合成媒体及合成响应，不能证明 Qwen 真人声纹准确率或真实会议采集效果。
- `0214_voiceprint_sampling_stop_reason` 在隔离 PostgreSQL 应用成功，Django `check` 通过，迁移无漂移。变更服务、任务、API、迁移、测试及 agent 通过 Ruff；既有模型基线问题另记，未扩大为全仓清理。`uv lock --check` 通过，SDK 和依赖未升级，锁文件仅增加既有 aiohttp 的直接依赖声明。

## 本轮代码走查与修复

对上述已提交链路继续检查权限、异步时序、故障处理和资源生命周期，修复以下四项：

1. **采样来源检查存在异步竞态**：原先在等待后端验证之前检查 RTC 来源；等待期间静音或连接替换后，返回成功仍可能触发订阅，或上传已经缓存的音频。验证返回后再次检查同一参与者、轨道和静音状态。用合成帧及延迟验证覆盖订阅前、上传前的静音／连接替换四种情形，均不上传，订阅前失效也不订阅。
2. **队列故障改变已提交声明的响应**：`on_commit` 内提交 Celery task 失败，可能导致已经保存成功的本人设备声明向调用方抛错。现在保留提交结果，只记录固定的 `sampling_dispatch_enqueue_unavailable`，不记录底层队列诊断。持久派发恢复仍属下节待完成范围，不能把声明成功当作采样已启动。
3. **SDK 资源关闭没有期限，部分异常绕过固定错误码**：客户端构造与关闭纳入同一错误边界；RPC 保持 5 秒上限，关闭增加 2 秒上限，两类超时均取消正在等待的协程。构造、RPC、关闭故障统一转为固定可重试错误，不透传底层私有诊断。
4. **数据库游标可能晚于派发事务回滚才释放**：首个合格来源提前返回或 SDK 抛错时，显式在事务退出前关闭查询迭代器，避免 PostgreSQL server cursor 在回滚后才被回收。测试分别验证成功与失败路径的关闭时机。

验证：先运行故障复现，确认队列提交、SDK 构造／关闭和 RTC 竞态在修复前失败；修复后 75 项采样后端回归通过（37.84 秒），44 项 agent 回归通过。后端将 `PytestUnraisableExceptionWarning` 作为错误处理，未出现游标延迟回收异常。新增 7 项后端用例和 1 项 agent 用例（含四个竞态子情形）；变更通过 Ruff 和 `git diff --check`。以上为本轮针对性回归，不与前述 402／43 项重复累计；没有进行实际会议或真人效果验证。

## 配置与剩余范围

后端 `MEETING_VOICEPRINT_SAMPLING_ENABLED` 默认 `False`，`MEETING_VOICEPRINT_SAMPLING_AGENT_NAME` 和独立 token 默认空。agent 需同名配置、同一独立凭证、LiveKit 连接配置及内部后端地址；只有 `MEETING_VOICEPRINT_SAMPLING_ENABLED=true` 才接受派发。入口及开发环境说明见 [agents README](../../src/agents/README.md#声纹采样入口)。这些配置没有在生产启用。

设备组模板、贡献失效重建及跨会话条件的后续证据见[设备组模板走查](voiceprint-device-templates-review-2026-10-10.md)；来源删除后的数据库物理清理、持久意图与周期恢复见[来源删除走查](voiceprint-source-removal-review-2026-10-10.md)。仍需 Web／Android 通话声明和可见采样状态；派发与采样状态的持久恢复、许可／无引用轨道周期回收；Helm／镜像／独立服务、监控及容量验证。实际 LiveKit 房间的合成参与者联调也未完成，原生本地音轨测试不能替代完整 RTC 链路。完整产品路由、历史版本／搜索、真实设备、获授权真人效果和生产验收继续推进，完整目标保持不变。
