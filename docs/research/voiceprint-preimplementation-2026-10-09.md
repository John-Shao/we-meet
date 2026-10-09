# 声纹身份识别：实施前代码与资料调研

日期：2026-10-09（Asia/Shanghai）\
对应方案：[声纹方案 v1.5](../plan/speaker-identity-voiceprint-plan-2026-10-09.md)\
结论：代码与公开资料调研完成；方案仍待评审，P0 实测未完成，业务功能未实施。

用户确认当前没有可用于评测的获授权真人录音，先完成代码与资料调研。本轮不采集用户音频、不调用计费 ASR、不修改生产配置、不安装模型推理依赖。进行了公开模型元数据核验、当前本机 SDK 接口探测和合成向量比较耗时探测；没有运行声纹模型，不产生识别准确率结论。

## 1. 结论与建议调整

整体路线可以保留：已授权独立音轨采样、本人确认登记、组织内匹配、人工确认最终身份。人工标记通讯录与自定义标签可独立实施和验收，不依赖声纹效果。

实施前需要冻结以下调整：

1. LiveKit identity 对应 `User.sub`，不能视为 `User.id`；许可必须携带由后端解析的账号、房间会话、participant SID 与 track SID。
2. 声纹采样从 `SUBSCRIBE_NONE` 开始，逐轨授权；媒体 SDK 队列和后续处理队列都需有界，不能只限制最后一个生产者队列。
3. 文件分人仅支持单声道，建议不超过两小时；首期身份识别设置两小时上限，并进行音轨、声道和时长预检，保留原文件和准确时间映射。
4. 按用户要求优先评估 Qwen3-TTS Base 的 24 kHz／1024 维 speaker encoder；CAM++／ERes2NetV2 的 16 kHz／192 维模板作为对照备选，不混用，仍需真人评测决定模型和门限。
5. 人工标签需同步扩展 Python 名称解析和 SQL 投影，不是只改显示组件。现有编辑权限限于 AI 录音／导入；在线会议仍按连接账号显示。
6. 独立录音分人不能简单新增一组 `transcription_job=null` 的片段：当前 generation 查询会同时保留所有此类片段，可能造成重复原文。必须设计显式的派生 generation／归属覆盖层。
7. 已有备份说明为加密备份、对象保留 30 天；“在线数据 24 小时清理”不能表述为所有备份立即物理删除。恢复前需核验当前撤销墓碑，并验证部署实际策略。

## 2. 调研完成度

“代码确认”指本地工作树；“资料确认”指官方来源；“未实测”不能被解释为功能已具备或已经验收。

| 项目 | 已完成 | 仍需完成 | 当前结论 |
|---|---|---|---|
| 独立音轨与身份 | Web／Android 通话进入 LiveKit；后端身份规则；定轨订阅及 PCM 接口 | 实际房间连接、撤销、重连、共用设备、生产 E2EE 状态 | 接入基础存在，真实采样仍未验证 |
| 转写与分人 | 当前模型、分人参数及返回处理；官方输入约束；原文投影机制 | 真人插话／噪声、单声道转换、分人时间轴与手工修订联调 | 导入协议接通；独立录音需新增派生层 |
| 模型 | 官方模型 ID、revision、维度、许可声明和权重清单／哈希 | 依赖锁定、权重下载后校验、模型推理、中文／跨设备评测 | 两个候选可进入离线对照，尚不能定优劣 |
| 样本防污染 | 来源可信度分类与入库规则设计 | 本人、旁人、回声、重放、跨设备的真实样本测试 | 首期逐次本人确认，不能开放无人确认更新 |
| 通讯录与标签 | 现有权限／API／两端组件／名称投影与下游引用 | 数据契约评审、交互走查、并发／兼容测试 | 可独立成首期工作包 |
| 授权与删除 | 临时音频时间窗、备份文档、源删除和撤销设计 | 实际 KMS／存储／备份验证、墓碑恢复测试、告知文本确认 | 尚无声纹授权／删除实现，需先建再采集 |
| 容量成本 | 本机环境和小集合向量比较探测；仓库 Helm 声明 | 生产资源盘点、媒体解码／模型推理／端到端并发基准 | 不需先引入向量数据库；不能承诺整机容量 |
| 真人评测 | 采样清单、独立集合划分、指标和门槛设计 | 获授权测试人员和录音、独立评测执行 | 用户当前无样本，保留待验证状态 |

## 3. 音轨与身份：代码证据

### 3.1 三类通话可复用媒体基础

- [Web 通话控制](../../src/frontend/src/features/im/call/callController.ts)先创建 LiveKit 房间再发送邀请；[会议组件](../../src/frontend/src/features/rooms/components/Conference.tsx)在同一媒体容器中区分语音、视频和多人会议展示。
- Android `feature-im/.../call/CallController.kt` 同样解析房间并取得 LiveKit 凭据，实际媒体由 `app/.../livekit/LiveKitController.kt` 连接。摄像头开关不影响麦克风身份来源。
- [后端 token](../../src/backend/core/utils.py)使用登录用户的 `sub` 作为 identity；匿名使用单独的 participant_id 或随机值。显示名称可以由 username 覆盖，因此不作为声纹身份真值。
- `User.sub` 是唯一、可空的账号外部主体标识；数据库主键另有字段。采样时必须确认账号当前有效、sub 非空且对应唯一登录用户，同时排除匿名和机器人。

### 3.2 定轨接收已有参考实现

[私人翻译](../../src/agents/src/translation/private.py)已有 `SUBSCRIBE_NONE` 连接、identity 与 participant SID 比较、麦克风来源过滤、track SID 固定、16 kHz 单声道 PCM 和换轨停止的实现，可借鉴协议，不直接复用其“开启翻译”授权作为声纹授权。

当前[会议转写](../../src/agents/src/transcription/runtime.py)使用 `AUDIO_ONLY` 自动订阅。新的声纹 agent 需要独立采样许可与调度，不因某个用户授权就接收其他人的音轨，也不要求普通通话开启 ASR。

本机 `livekit==1.1.19` 的 `AudioStream` 提供采样率、声道和 capacity 参数，`RemoteTrackPublication` 有 `set_subscribed`。检查其已安装源码确认 capacity 默认 0 表示无界队列；新实现需指定帧队列容量并测试消费滞后时的行为。该探测只验证本机 SDK 接口，不是实际音轨接收测试。

### 3.3 E2EE 与版本

仓库声明：Web `livekit-client=2.17.1`、Android `livekit=2.24.1`、agents `livekit-agents=1.4.5`；生产配置模板声明 LiveKit server `v1.12.0`。没有将这些声明当作生产运行版本。

本次核查的 Web／Android／agent 连接入口未看到 E2EE 配置或密钥提供器。只能得出“这些代码入口未配置”的结论，不能证明生产所有场景未使用 E2EE。官方说明 agent 作为房间参与者也需要相同的加密密钥才能解密输入；应验证密钥分发与授权，不默认关闭加密以方便采样。[LiveKit 官方说明](https://docs.livekit.io/transport/encryption/agents/)

## 4. ASR、分人与时间轴

当前[文件适配器](../../src/backend/core/services/qwen_filetrans.py)固定 `qwen-audio-3.1-asr-flash-filetrans`，提交 `diarization_enabled`，请求第 0 路音轨，并把返回的 speaker_id 存入说话人来源。官方确认该文件模型支持分人；启用参数与现有代码一致。文件版参数不能混用短音频 Flash 的另一组命名。[模型说明](https://help.aliyun.com/zh/model-studio/asr-model)、[非实时接口说明](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)

文件分人只支持单声道，官方建议分人文件不超过两小时。建议新增身份识别预检：确认音轨和声道，选择正确媒体流，必要时生成短期单声道识别输入，并记录原时间映射；不能默取第一个声道而遗漏另一路人员。首期对超过两小时的身份识别给出明确限制，分块与跨块身份关联另行验证；保留已有普通转写和人工标记路径。[官方约束](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)

独立录音的[发布服务](../../src/backend/core/services/capture_transcription.py)仍生成 unknown speaker。其 `MeetingOriginalSegment` 和 `MeetingSpeaker` 来源不可变。当前[有效原文投影](../../src/backend/core/services/effective_transcripts.py)选择“没有 transcription_job 的片段”或“当前 active_transcription 的片段”；不包含新的分人 generation 规则。

因此录音后分人建议先设计一种独立派生映射：标注 source generation、原始片段／时间范围、派生 speaker 和人工修订引用，原文仍由已有 active transcription 投影提供。不得直接 bulk_create 无 job 的重复原文，也不能把分人任务伪装成一次 ASR 重试。词级时间戳不可靠的跨人句子保留歧义，交由人工复核。

现有 `src/agents/evaluations/asr_quality` 是 SAPI 合成语音及模拟噪声；其 README 明确排除真人会议与真实分人准确率。此次不将已有录音文件或未知来源材料当作用户允许建立声纹的样本。

## 5. Qwen 优先的模型和部署选择

### 5.1 已核验的 Qwen 能力与边界

用户要求尽量使用 Qwen，选型优先级已调整，不再将 CAM++ 作为既定首选。

| Qwen 能力 | 已确认 | 与实名声纹库的关系 |
|---|---|---|
| 文件 ASR 分人 | 返回 speaker_id 与时间段 | 可作为提取各人声音的前置步骤，不返回已登记的账号姓名 |
| Qwen-Audio-Realtime 目标说话人增强 | smart_turn 接受参考声音，锁定目标说话人 | 适合目标声音过滤，已查文档未提供本方案所需的多人身份检索契约 |
| Qwen3-TTS Base speaker encoder | 开源实现可提取说话人特征 | 优先研究用其特征建立本地库，身份质量和未知拒绝必须实测 |

Realtime 的资料依据是 [QwenCloud 官方指南](https://docs.qwencloud.com/developer-guides/speech/qwen-audio-realtime)。不能把其会话声纹加载事件当作可持久存储、任意跨录音查询的身份库接口，也不能把语音克隆返回的音色 ID 当作人员识别结果。

开源候选固定为 `Qwen/Qwen3-TTS-12Hz-0.6B-Base`，模型 revision `5d83992436eae1d760afd27aff78a71d676296fc`；其 [配置](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/blob/5d83992436eae1d760afd27aff78a71d676296fc/config.json)声明 speaker encoder 为 24 kHz、1024 维，官方元数据声明 apache-2.0。[提取方法](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7e1e916cb940cdf532cd9f488e/qwen_tts/core/models/modeling_qwen3_tts.py)在冻结 commit `022e286b98fbec7e1e916cb940cdf532cd9f488e` 中存在。

技术报告描述该 speaker encoder 与语音生成骨干联合训练；官方任务定位为 TTS。推断可以研究其特征用于匹配，不等于官方提供并验证了会议实名识别产品。[Qwen 官方技术报告](https://arxiv.org/html/2601.15621v1)

后续 P0 先验证仅加载 encoder 的可行性、原始输入分别重采样、近场／跨设备身份区分和未知拒绝；不生成克隆声音。若达标优先采用 Qwen，否则以同样本对照说明专用模型的必要性，再交评审决定。本轮未下载 Qwen 权重或执行模型，未确认独立 encoder 的内存／速度。

### 5.2 专用模型对照与依赖

在冻结的 3D-Speaker 源码 commit `065629c313eaf1a01c65c640c46d77e61e9607b4` 中确认了候选 revision 和输入／特征定义。两候选采用 16 kHz、80 维声学特征和 192 维 embedding，可在 CPU／CUDA 路径运行；上游示例使用余弦分数。其多声道示例选择第一声道，新业务不可不加检查地照搬。[官方推理源码](https://github.com/modelscope/3D-Speaker/blob/065629c313eaf1a01c65c640c46d77e61e9607b4/speakerlab/bin/infer_sv.py)

| 模型 | 官方 revision | 权重文件与声明大小 | 许可声明 |
|---|---|---|---|
| `iic/speech_campplus_sv_zh-cn_16k-common` | `v1.0.0` | `campplus_cn_common.bin`，28,036,335 bytes | 官方元数据和该版本卡片均声明 Apache License 2.0 |
| `iic/speech_eres2netv2_sv_zh-cn_16k-common` | `v1.0.1` | `pretrained_eres2netv2.ckpt`，71,768,231 bytes | 官方元数据和该版本卡片均声明 Apache License 2.0 |

以上是声明及清单核验，不是已下载权重的本地完整性验证或法律审查结论。[CAM++ 模型](https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common)、[ERes2NetV2 模型](https://www.modelscope.cn/models/iic/speech_eres2netv2_sv_zh-cn_16k-common)。原始 metadata、版本清单、卡片哈希留在调研工作目录，关键结果汇入[证据 JSON](voiceprint-preimplementation-2026-10-09.json)。

agents 项目要求 Python≥3.12，上游示例包含 torch、torchaudio、ModelScope 和音频重采样依赖；本机 Python 3.13.9 未安装 torch／torchaudio／ModelScope。建议独立模型镜像，单独锁定兼容依赖，在离线初始化中下载和校验固定权重，避免直接扩充正在运行的通话 agent 环境。上游存在 ONNX runtime 路线，但未核验本模型导出和声学前处理一致性，暂不作为既定优化。[官方 ONNX 入口](https://github.com/modelscope/3D-Speaker/tree/065629c313eaf1a01c65c640c46d77e61e9607b4/runtime/onnxruntime)

模型大小不能推导实际峰值内存，单一设备的理论性能不能推导生产并发容量。模型下载、推理和 benchmark 留待经评审的 P0 技术验证。

## 6. 防污染：确定规则与未验证部分

可以冻结的首期规则：

- 账号音轨仅证明来源连接；首次模板须本人确认，共用设备／匿名／系统音频／机器人排除。
- 后续片段逐次本人确认；稳定基准不被新片段直接覆盖，自动滚动更新延后。
- 片段质量拒绝、未知拒绝和声音冲突是正常状态；人工标签和识别成功不触发入库。
- 保持已确认模板的来源贡献，出现污染可删除贡献、重建或暂停 profile。

没有真人样本，无法确定语音最短长度、回声检查门限、多片段一致性门限、近场和远场错认率，也无法证明现有回声消除足以保护声纹库。将这些参数保留在校准表中，不使用公开 benchmark 的 EER 换算成本项目多人身份识别准确率。

未来防污染最小测试：本人单人、旁人插话、远端回声、共用设备、同账号换设备、借用账号、旧录音重放；登记与查询分开录制，以人工听辨标注真实归属。

## 7. 人工通讯录标记与自定义标签

现有[归属服务](../../src/backend/core/services/speaker_attribution.py)只接受 user_id 或清除操作；组织记录仅接受该组织有效成员。个人记录的写接口允许有效账号，但候选列表缩小为共同组织成员与本人。新通讯录接口应继续按当前可见范围校验，不能依赖较宽写规则枚举全站账号。

当前[API](../../src/backend/core/api/meeting_records.py)拒绝额外归属字段；候选仅支持姓名关键词 q、最多 50 个结果，无部门和外部联系人选择。Web 已有[归属控件](../../src/frontend/src/features/meetings/components/SpeakerAttributionControl.tsx)，Android `MeetingRecordApi`／`RecordSpeakerDto` 也已有成员归属字段，可扩展为统一面板。

通讯录中的 `ExternalContact` 是两个真实账号的关系，不是离线姓名条目；只有 accepted 关系进入联系人列表。组织记录选择外部联系人建议保存记录级姓名快照，保留现有跨组织成员绑定限制，避免同时改变共享身份和声纹权限。私人备注／电话／邮箱不进入快照。

当前 `can_edit_transcript` 明确限制 AUDIO 和 UPLOAD 源类型且需管理权限，因此首期人工标记适用于 AI 录音／导入；在线会议显示账号姓名，不在本阶段新增改名权限。

需一并改造的投影／契约：

| 链路 | 现状 | 首期调整 |
|---|---|---|
| MeetingSpeaker 模型 | label 是原始证据，user 是人工归属 | 增加 manual_label／kind，保持来源不可变 |
| Python display_name | 成员姓名／邮箱回退，再 label | 加入标签优先，成员与标签互斥 |
| SQL 名称投影 | `attributed_name_subquery` 自行解析成员字段 | 与 Python 保持相同规则，不能只改模型属性 |
| 转写／导出／纪要来源 | 有效原文投影读取 display_name | 复用统一解析，人工标签进入新输出；不重写历史快照 |
| 记录 revision | 现有归属服务未增加记录 revision | 增加并发检查和展示失效机制，评估是否触发已有任务取消 |
| 检索 | 存在在线 TranscriptChunk 专用索引 | 不能假定它覆盖录音／导入；逐入口核验后冻结验收范围 |
| 多端／旧客户端 | 成员归属 PATCH 与候选接口 | 新旧入口共用互斥／审计规则，先后端加法兼容再升级客户端 |

自定义标签建议 1～64 个字符、单行纯文本；持久化字段预留到 128 以容纳通讯录姓名快照，不能把联系人姓名按标签长度静默截断。无账号标签不能自动用于设置任务负责人。相同标签可用于多条来源，不自动合并说话人。

## 8. 授权、保留与删除

[临时录音保留服务](../../src/backend/core/services/capture_retention.py)将 text 模式硬期限设为开始后 24 小时，新音频任务重试窗为结束后 30 分钟且不越过硬期限。新分人／匹配任务必须同时服从“新任务准入窗”和“硬删除期限”，不能只看 24 小时。

声纹首次确认和通话采样是新的授权，不复用原 ASR／录音授权。持久声纹入库不使用仅文字保留的录音；查询派生音频不越过原期限。现有 Android 本地录音加密不能作为服务端模板已有加密的证明。

[运维说明](../installation/aliyun-release-runbook-cn.md)记载备份使用 age 加密，并由对象生命周期保留 30 天。这是文档证据，尚未核验生产桶生命周期、备份成功情况和恢复工具。声纹删除需区分立即禁止使用、在线清理和备份物理到期；撤销墓碑必须可从当前可信来源取得，不能仅存在于将要恢复的旧数据库备份中。

方案评审需要决定组织授权、联系人姓名共享、模板闲置期限、备份删除说明。上线前验证：撤销与提交竞态、退出组织、账号停用、来源删除重建、缓存解密权限和旧备份恢复拒绝匹配。

## 9. 本机能力与轻量探测

本机观察：Python 3.13.9、NumPy 2.4.4、LiveKit RTC 1.1.19；CPU 为 Intel Core i9-14900HX（32 逻辑处理器），`nvidia-smi` 报告 RTX 4070 SUPER（12,282 MiB）。未发现命令路径中的 ffmpeg／uv，也未安装模型推理所需 torch 等库。这不是生产资源盘点。

合成向量比较探测：固定随机种子、float32、192 维；模拟 10 个查询说话人每人 5 个片段，对比 50 名候选每人 5 个模板，即 50×250 的分数矩阵。20 次预热、200 次比较，本机 P50 约 0.375 ms、P95 约 0.810 ms；输入向量 230,400 bytes，输出 50,000 bytes。

探测只包含已归一化向量的矩阵乘法，不包含授权查询、解密、媒体接收、解码、VAD、特征提取、聚类、模板聚合或排队。因此只支持“小候选集合先直接比较”的工程判断，不能证明模型速度、准确率或 60 秒端到端目标。

为 Qwen 候选补做 1024 维同形状探测：50 个查询向量、250 个模板，20 次预热／200 次测量，本机 P50 约 0.843 ms、P95 约 1.566 ms，输入向量 1,228,800 bytes。仍为随机向量乘法，不是 Qwen encoder 推理或实际检索链路；192 维探测结果不得冒充 Qwen 性能。

仓库 Helm 对 meetingAIWorkers 的多数 resources 使用空对象，没有新增声纹进程的配额声明。需要独立 worker 的 requests／limits、并发和熔断，不能沿用其他服务的配置值当作容量结论。

## 10. 真人评测与下一步准入

目前可以完成资料与契约评审、人工标记的交互评审；不能声称 P0 整体通过或放行自动识别。

准备好获授权样本后执行以下顺序：

1. 小规模可行性：5～10 名自愿人员、至少两次会话和两类设备，验证能否区分本人／他人及拒绝未知；只用于排除不可行方案，不做上线准确率承诺。
2. 校准与独立验收：按方案至少 30 名参与者、多会话／设备，分离登记、校准和测试；同时测分人和身份匹配。
3. 防污染专测：共用麦克风、旁人、回声、账号借用、重放和声音变化，不把多个切片视作独立人员样本。
4. 资源与权限联调：实际部署规格下测媒体订阅、端到端延迟、撤销和删除；没有这些结果不确认生产容量。

建议的放行顺序：

- **人工标记工作包**：通讯录／标签数据契约和权限评审通过后，可先实施，不依赖模型推理。
- **主动声纹登记＋导入建议**：模型环境、真人效果、授权／删除和真实 ASR 分人均验证后，进入首期实施／试点。
- **通话积累**：在前项基础上，独立音轨采样和防污染实测通过后再开放。
- **自动更新、自动归属、实时识别**：继续保留独立评审和效果门槛。

所有“可先实施”均指评审通过后，本轮没有修改业务代码。未解决项目作为方案评审的明确条件，不以现有合成样本或本机向量耗时替代。

## 11. 证据与可复核范围

结构化摘要见[证据 JSON](voiceprint-preimplementation-2026-10-09.json)，包含官方 URL、模型 revision／许可声明／权重清单哈希、本机探测结果和主要代码文件的 SHA-256。代码证据来自当前工作树，可能含用户已有修改；文件哈希用于复核，不将 git HEAD 当作全部工作树内容。

公开模型原始资料及探测输出保存在工作区 `work/voiceprint-research-2026-10-09/`，未下载模型权重和示例音频。没有连接生产服务、使用供应商凭据或采集真实声音。后续代码／模型版本变化时，应重新核验受影响的结论。
