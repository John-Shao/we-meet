# 会议 AI 翻译：Qwen 模型选型与复用接入方案

日期：2026-09-12
状态：**批次 16–19 完成协议、私人会话控制、指定音轨 Agent 与 Web 入口；多人同传、笔记关联及设备实测待完成。** 详见 [协议](meeting-ai-translation-batches-2026-09-13.md#translation-batch1)、[会话控制](meeting-ai-translation-batches-2026-09-13.md#translation-batch2)、[音轨 Agent](meeting-ai-translation-batches-2026-09-13.md#translation-batch3)、[Web 入口](meeting-ai-translation-batches-2026-09-13.md#translation-batch4)。
关联：[会议 AI 产品规划 V2](meeting-ai-product-plan-v2-2026-09-12.md)。本文件更新 V2 原先把同传放在 P3 的安排，新增 P1-T 接入阶段。

## 1. 已确定的选型

实时音频翻译统一使用 `qwen3.8-livetranslate-flash-realtime`，覆盖两种产品模式：

| 模式 | 场景与交互 | 输入组织 | 输出 |
| --- | --- | --- | --- |
| 同声传译 | 线上会议、演讲、录音中持续收听；选择“我想听的语言” | 连续音频流，建议服务端 VAD；每个翻译会话明确一个目标语言 | 目标语种支持时提供译音+译文，可调原声音量 |
| 语音翻译 | 面对面双向交流、访谈；选择语言 A/B | 复用逐句 VAD/语言路由；也可提供按下说话、松开提交 | A→B 与 B→A 对应的译音+译文；文本语种只显示译文 |
| 实时翻译文字 | 会议字幕、AI 录音的译文视图 | 音频输入，按目标语种处理 | 仅文本输出；不是把已生成的文字交给音频模型 |

资料来源：用户提供的模型说明及 [阿里云官方模型文档](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)（本次已核对）。模型覆盖 60 种语言，其中 29 种可输出音频+文本，31 种仅输出文本；界面必须按目标语言能力筛选。同一语言对做双向语音时，两个方向的目标语言都必须支持音频。官方“低至 2.8 秒”属于模型宣传指标，不能作为 we-meet 包含采集、路由、网络、播放的端到端 SLA。

“语音翻译”作为产品入口名称，代码模式继续使用明确的内部枚举；不要让旧项目的 `standard_translation` / `simultaneous_translation` 与供应商配置绑定成不可调整的同义词。

模型名、地域、Workspace ID、固定音色通过服务端配置；沿用 `QWEN_TRANSLATION_MODEL`、`DASHSCOPE_REGION`、`DASHSCOPE_WORKSPACE_ID`、`DASHSCOPE_API_KEY` 等配置名可减少迁移成本。密钥留在 Agent 服务端。上线记录实际模型版本，必要时评估锁定快照，不能把 alias 的行为视为永远不变。

## 2. 已有项目代码检查结果

复用来源：`D:/workspace/jusi-team/jusi-meet-suite/src/agents/`。只做了静态阅读，未启动服务、读取实际密钥或调用模型，未修改来源项目。

| 文件 | 已观察到的实现 | 对 we-meet 的意义 |
| --- | --- | --- |
| `qwen-livetranslate-agent.py` | 默认模型即本次选型；读取 requester、controller、translation_session_id 和语种；从指定参与人读一条音轨 | 可复用采集桥接，但当前输入范围不是整个多人会议 |
| 同上：`entrypoint` | 为 A→B、B→A 建两个固定源/目标的客户端；发布一个 `translation-audio` 音轨，标记 `standard_translation` | 已有双向语音翻译实现；多收听语言的同传频道仍需编排与隔离 |
| 同上：`_audio_input_loop` | Silero VAD、语言探测和双向路由，语音段结束调用 commit | 适合逐句双向翻译；连续同传不能直接继承逐句完整等待的延迟 |
| `plugins/qwen/live_translate_client.py` | PCM 输入 16 kHz、输出 24 kHz；Workspace/地域 WS 地址；固定音色，未启用声音复刻 | 协议层、重采样约定、鉴权配置可复用 |
| 同上：`_session_update` | 当前固定 `modalities=[text,audio]`、`turn_detection=None`，同时请求源语言 ASR | 要扩展输出模态和 VAD/Manual 配置，不能只改 UI 选项 |
| 同上：`_normalise` | 处理源语言识别、`response.audio_transcript.*`、音频 delta 与 usage；当前未归一化 `response.text.text/done` | 纯文本目标语言需要新增事件分支，不能直接开放所有 60 个语言选项 |
| `plugins/translation_language_id.py` | 提供语音语种检测和双向语音段路由 | 复用双向模式；同传固定目标且可自动识别来源时，不必无条件增加这层调用 |
| Agent 中的语言检测配置 | 另用 `qwen3.5-omni-flash` 作语种检测默认值 | 翻译模型已统一，但现有方案还有独立辅助模型调用与费用，需要明确记账 |
| `plugins/translation_languages.py` | 产品当前显式开放 8 种语言，旧同传存在中/英枢轴限制 | 这是旧产品限制，不是 Qwen 的模型能力上限；重建能力表，不原样迁移 |
| `plugins/volcengine_ast/{events,control,reporter}.py` 等 | Qwen Agent 也复用事件投影、退出音频门控、空闲策略、任务取消与服务端上报 | 迁移应包含依赖链；通用能力可放进 provider-neutral 包，不能只复制一个入口文件 |
| `plugins/chat_history` | Agent 调用 start_recorder/record_translation，当前数据消息按房间发布 | 存储与广播接到 we-meet 的 record/session/ACL；不能继承原项目全部历史记录或广播策略 |
| `tests/test_qwen_live_translate.py` 等 | 已有握手、配置、无效音频、连接恢复、语音段内断线等测试代码 | 作为迁移用例来源；本次未运行，不宣称在 we-meet 已通过 |

已有正常结束流程先 request_finish，再等待服务端完成及事件消费，再关闭；音频队列有上限，满时丢旧片段以控制延迟。迁移时保留尾段保护，并把队列溢出、尾段超时作为可观测事件。上限不能盲目沿用：按音频时长而非未知 chunk 数量定义缓冲预算。

## 3. 接入边界与架构

目标链路：授权音频来源 → LiveKit/独立采集适配 → 翻译会话管理 → Qwen 客户端 → 译文事件与译音频道 → 个人收听与会议笔记。

建议模块：

- `qwen_live_translate`：协议客户端和事件解析，参数化连续/按键输入、源/目标语言、输出模态、音色及热词；不承载产品权限。
- `translation_session`：启动、停止、切换、订阅人数、授权和费用归属。生命周期独立于 MeetingSession 和 CaptureSession。
- `translation_audio`：来源选择、重采样、音频分片、输出轨道、队列与回声防护。
- `translation_events`：source/target、partial/final、record_id、meeting_session_id、translation_session_id、speaker_id、source_segment_id、语言及时间映射。
- `translation_reporter`：使用 we-meet 后端的内部身份校验、状态持久化、AIUsage 与审计。

三种来源分别处理：

1. **线上多人会议**：只接入授权的人类原始音轨，显式排除翻译 Agent/TTS 音轨。优先保留按说话人区分的流；同一目标语言的多个发言来源需有可解释的播放调度。重叠发言不得悄悄归到同一个人名。
2. **线下 AI 录音**：设备麦克风是一条混合流。复用双向语言路由，但说话人区分需要独立能力，不能把“语言 A”直接当作“说话人 1”。
3. **按键语音翻译**：明确选择输入方向，直接提交该方向音频；无需每段都调用语种检测模型。

私有翻译频道按读取范围分发，服务端限制数据接收者和音轨订阅权限；仅在前端静音不能视为隔离。同场、同源范围、同目标语种、同输出模式/音色/热词和相同权限时才考虑共享供应商连接。不同用户的独立录音或私人记录不共享上下文。

一个用户关闭收听只停止自己的播放/订阅；有其他订阅者时保持共享频道。最后一个订阅者离开后按空闲策略释放会话；主持人停止公共翻译才结束公共频道。切换语言使用会话 generation 标识，清除旧译音队列并丢弃迟到的旧会话事件。

同传优先连续输入、固定目标语言，由源音轨或源识别结果标记说话人；双向交流保留两个固定目标方向，3.8 按键模式每轮结束后重建该方向的供应商连接。两种模式共享协议实现，不共享不适合自身体验的输入调度。

## 4. 关键协议契约

下列契约依据用户附件与官方说明；实现时配合已有客户端逐项适配，而非直接粘贴示例运行。

- 音频是必要输入，图像为可选增强；首期只接音频。后续如使用屏幕/视频图像，必须明确用户选择的输入源及对应权限。
- 源语言可自动识别，目标语言必须由用户/频道配置明确给出；不依赖供应商默认英语。
- 3.8 使用 `output_modalities` 和嵌套 `audio.input` / `audio.output`；连续同传设置 `audio.input.turn_detection.type=server_vad`。按键模式也使用服务端 VAD，松开后以 `session.finish` 收齐本轮，再准备下一轮连接；不发送旧版 `turn_detection=null`、`input_audio_buffer.commit` 或 `response.create`。
- 3.8 仅文本输出接 `response.text.delta` / `.done`；文本+音频接 `response.audio_transcript.delta` / `.done` 及 `response.audio.delta`。新增 delta 按 response/item 顺序累加，完成帧以完整文本校正；完成后的迟到片段不再追加。
- UI 展示累计候选文本；`.done` 文本事件不等于本轮成功，只有 `response.done(status=completed)` 确认后才能落库。保留旧快照事件解析以处理历史测试，不把快照当作新增 delta 累加。
- 3.8 原生 ASR 始终开启，不能发送旧版关闭参数；适配器默认丢弃源候选输出，仍沿用原转写链路。源 ASR 的 delta 累加、completed 完整校正，仅作原文候选来源；目标译文不能覆盖原文。多个目标翻译会话返回重复源 ASR 时，用原始输入段 ID 归并，不按各供应商 item_id 各存一份。
- 正常停止发送 `session.finish`，等待 `session.finished`，并确保已收到的末段事件完成落库。用户停止播音立即生效，尾段服务端清理可以继续；超时显示可恢复失败而非永远等待。
- 3.8 使用 `audio.output.voice=Tina` 固定音色，不发送旧版声音复刻参数。热词按租户/会议配置，可逐步支持专业词汇；不在每个普通用户面板展示模型参数。

语言能力注册表至少包含：code、label、input_supported、text_output_supported、audio_output_supported、enabled。在同传“收听语言”只列音频支持且已上线的语种；仅文本语种仍可作为译文语言。双向语音的两个方向都要做输出能力检查。语言别名规范化沿用全站约定，不把旧产品的 `zhen` 伪代码发给 Qwen。

## 5. 与现有转写和纪要衔接

we-meet 当前 `src/agents/plugins/doubao_translate.py` 接收已有 FINAL 文本并翻译，`multi_user_transcriber.py` 负责原文、译文广播和写入。Qwen LiveTranslate 要求音频输入，因此不能用它直接替换 `translate_many(text, ...)` 而不改变音频数据链路。

本次选型约束实时语音翻译和同传；历史纯文字翻译继续保留文本翻译适配层。若历史记录有授权音频，可另走媒体重放处理；仅有文本的记录不合成伪音频来套用此模型。

迁移初期保留现有转写为原文主来源，Qwen 输出用于翻译及对齐，避免两套 ASR 重复落库。只有对原文准确率、时间轴和说话人映射完成对比评估后，才考虑让 Qwen 的源 ASR 承担对应采集流的主转写。

纪要默认基于原文生成；译文是阅读层。语音翻译临时会话默认不因为启用了翻译就自动创建永久会议笔记；在已开启 AI 录音/纪要的会话中，按该记录保存策略关联源文本及 final 译文。是否保存译音单独配置，首期默认只播不另存译音。

## 6. 产品设置与交互

录音/会议的翻译面板保留清晰的三个入口：

- **文字翻译**：不翻译 / 目标语言，显示原文或双语。
- **同声传译**：收听语言、开始/停止收听、原声音量；状态为连接中/正在翻译/重连中/已停止。
- **语音翻译**：选择语言 A/B、自动双向或按键说话，分别展示两侧原话与译文，可暂停播报。

翻译停止不停止会议、录音或原始转写；录音结束按正常尾段流程关闭其关联翻译。翻译失败保持通话与采集，提示当前译文/译音不可用，不能悄悄改为另一个收费供应商。仅音频输出失败时可以保留已经可用的文字。

现有 V2 原型中的“同声传译后续支持”是尚未接线的展示占位；此处更新模型与交付阶段，未把原型或业务程序改成真实同传。

## 7. P1-T 交付拆分与验收

1. **协议与配置适配**：迁入客户端及必要依赖；参数化模态/VAD，补纯文本事件，建语言能力表，适配内部上报及服务端配置。
2. **双向语音翻译**：复用现有指定音轨+双会话路由；先覆盖中英核心流程，再按语言能力表与验证结果扩展。按键模式和自动模式分别计量延迟。
3. **连续同传**：连续流、多发言人来源、目标语言频道、订阅权限、原声/译声混音、切换与取消；与录音/会议生命周期对齐。
4. **文字与笔记关联**：原文和 final 译文去重、时间映射、权限化分发、历史查看和费用归因。

验收至少覆盖：

- 单向连续同传与双向语音分别使用正确输入模式，目标语言切换不播旧队列。
- 两名发言人、多个收听语言、重叠发言、加入/退出会议后来源与权限仍正确。
- 文本-only 语种不创建无效音轨；双向选择存在不可播音方向时清楚提示。
- 译音不回灌原文、不进入新的翻译循环；耳机和扬声器场景分别验证。
- 部分文本修订不重复显示，源 ASR 不随目标语言数量重复落库。
- 自然停止收齐最后一句；立即停播、房间断开、服务端 finished 超时均能释放资源并记录结果。
- 断线重连、队列溢出、额度/并发限制、无有效语音时不伪报成功，不无限积压。
- 服务端鉴权覆盖启动/停止/数据/音轨；旧 Agent 的房间广播策略不泄露私人翻译。
- 语种检测模型、每个目标频道和重试的费用可归属到组织及翻译会话；按实际 usage 记录，不预填价格。

衡量：从对应原始语音时间点到首个稳定译文/首段译音的延迟、连续翻译滞后 P50/P95、停止尾段丢失率、断线恢复率、源文/译文准确性。现有 Agent 的首次音频日志从会话启动计时，包含等待发言时间，不能直接用作端到端同传延迟指标。

旧项目作为复用来源保持不变。协议客户端已在本项目实现并通过隔离测试；真实会议 Agent 接线、权限分发及设备测试仍待后续批次。

## 9. 2026-09-23：3.8 协议升级与发布验收

本节记录本次实现，前文第 2 节是旧版参考代码盘点；Phase 0 的 3.5 实测数据保留原样，不能作为 3.8 已验证的证据。

| 范围 | 本次处理 | 验收重点 |
| --- | --- | --- |
| 会话参数 | 默认模型升级为 `qwen3.8-livetranslate-flash-realtime`；输入 16 kHz 单声道 PCM，输出 24 kHz PCM；使用嵌套音频配置 | 北京/新加坡 workspace 权限与会话握手 |
| 文本流 | 原文与译文 delta 分开累加，限制文本长度和未完成项数；完整响应覆盖候选 | 中英双向、纯文本与译音模式、多片段交错、尾句与重复事件 |
| 按住说话 | 服务端可能在按住期间分句输出；松开后结束本轮连接，等尾句消费完并为该方向重新握手后发 `turn_completed` | 不能在中间一句 `response.done` 时解锁下一轮；静音、连续两轮、切换方向、结束按钮、取消与握手失败 |
| 计费与原文 | 按各 `response_completed` 累加真实 usage；`turn_completed` 不新增 token 用量；原生 ASR 不写入正式原文 | 译文不覆盖原文，无重复记账；缺失用量继续标记未知 |
| 配置一致性 | 后端冻结配置、Agent 许可校验、录音 Web 协议、三个翻译 Worker 默认配置同步升级 | 旧运行记录不改模型名；新旧进程混用时拒绝配置不一致 |

按键模式每轮新增一次供应商握手，会增加连接次数与等待时间；容量验收必须检查账户实际 RPM 限制。这里的“按键”指用户控制输入，不能宣称供应商仍使用旧版 Manual 模式。连续同传无需每句重连。

发布步骤：

1. 本地执行协议/网关/同传测试、后端翻译服务测试、前端协议与状态机测试、TypeScript 检查及 Helm 渲染；构建同一提交的 backend、frontend、agents 镜像。
2. 生产先等待活动翻译结束，在无活动翻译的窗口联合发布这三个镜像。检查服务器自有 values/环境文件是否覆盖 `QWEN_TRANSLATION_MODEL` 为旧值；三个翻译 Worker 均应为 3.8。密钥继续使用已有 Secret，不修改历史配置快照。
3. 部署后用已授权的短合成音频运行 `bin/meeting-ai-phase0.py --live-translation --region cn-beijing --audio <16k-mono-pcm16.wav> --translation-mode server_vad`，分别补测 `--text-only`、`--target zh`、`--translation-mode manual`。脚本使用生产适配器；manual 测试的是按键收尾，不会发送旧版 commit。凭据通过环境或 `--secrets-file` 本地读取，不放命令行或日志。
4. Web 验收录音翻译、私人翻译、同传频道；特别检查按键连续两轮、尾句、静音、断网和撤权。失败不自动重放音频，不影响原录音。
5. 出现模型权限、协议或质量问题时停止新翻译，协调回退 backend/frontend/agents 镜像与三个 Worker 模型配置；只回退模型字符串不能恢复旧协议。Work 功能沿用已有 overlay，无需再次执行 `enable-work.sh materials`。

停止时，私人翻译的输入队列与供应商收尾共享 20 秒预算；不再用旧的 5 秒输入队列超时截断按键尾句，也不为已停止的任务预建下一轮连接。

本地验证：Agent 协议/私人翻译/网关/同传共 98 项、后端翻译服务 31 项、前端协议与状态机 23 项测试通过；TypeScript 检查、Ruff 与三个翻译 Worker 的 Helm 模型渲染检查通过。探测脚本离线配置检查通过。

追加浏览器验收（2026-09-23）：`check-capture-translation.mjs` 与 `check-capture-translation-ui.mjs` 均通过。使用 Chromium 合成设备和隔离后端，验证 3.8 一轮多句响应不会提前解锁、同方向旧 `turn_completed` 不会解锁新轮、说话中停止后收齐尾句、中英方向切换、单次麦克风打开及原录音继续。真实 React 控件与窄屏布局也通过；这些结果不代表百炼真实接口或生产 Worker 验收通过。

线上只读检查：前端入口资源已含 3.8 模型标识，不含旧 3.5 标识；公开配置中 Work、会议记录、音频采集与纪要请求均为开启。入口资源与本地 `0a9e4b146` 镜像不同，不能据此认定线上精确提交号。公开接口不提供各 Worker 模型，因此仍需在服务器执行以下只读检查，核对镜像、就绪副本及模型覆盖值：

```bash
kubectl -n meet get deployment meet-backend meet-agent-translation meet-agent-interpretation meet-agent-capture-translation \
  -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas,IMAGE:.spec.template.spec.containers[*].image'
kubectl -n meet get deployment meet-agent-translation meet-agent-interpretation meet-agent-capture-translation \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.template.spec.containers[*].env[?(@.name=="QWEN_TRANSLATION_MODEL")]}{.value}{end}{"\n"}{end}'
```

三个翻译 Worker 的模型应为 `qwen3.8-livetranslate-flash-realtime`；若某个 Worker 尚未启用，明确记录为未验收。若服务器私有 values 覆盖了旧模型值，需要同步更新后重新发布。以上命令不输出凭据。

本地尚未配置百炼实时翻译凭据，3.8 真实握手、译音、翻译质量与生产部署状态需以发布后的验收结果为准。

协议依据：[客户端事件](https://help.aliyun.com/zh/model-studio/live-translator-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/live-translator-server-events)、[3.8 模型说明](https://help.aliyun.com/zh/model-studio/qwen3-8-livetranslate-flash-realtime)。
