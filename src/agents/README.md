# Meeting agents

这是独立部署的 Python worker 子项目。依赖由 `pyproject.toml` 和 `uv.lock`
管理；`src/` 是源码搜索根目录，不是 Python 包，导入使用
`from capture...`、`from translation...` 等路径。

## 目录职责

```text
agents/
├── pyproject.toml / uv.lock / Dockerfile
├── src/
│   ├── entrypoints/       # 各独立进程的启动入口
│   ├── transcription/     # 会议原文转写、交付、观测与诊断
│   ├── capture/           # 独立录音实时和会后转写，共享执行生命周期
│   ├── translation/       # 私人翻译、共享同传、录音翻译及译文归档
│   ├── assistant/         # 多模态助手与音视频编排
│   ├── metadata/          # 会议元数据采集
│   ├── voiceprint/        # 取得逐轨许可后短时采样，独立加密候选入库
│   ├── transport/         # 后端 HTTP 传输，禁止携带凭据重定向
│   ├── identity.py        # 公共身份校验
│   └── plugins/
│       ├── qwen/          # ASR、Filetrans、LiveTranslate、Omni
│       └── doubao/        # STT/TTS/VLM pipeline、S2S、文本翻译
├── tests/
│   └── helpers/           # 共享假传输、任务、音频和参与者 fixtures
└── evaluations/
    └── asr_quality/       # 冻结语料、离线评分及显式供应商评估
```

业务模块不依赖 `entrypoints/` 或测试。供应商协议放在 `plugins/`；后端控制、
权限与交付留在业务模块。共享功能应放在明确的公共模块，避免跨业务导入私有函数。

## 声纹采样入口

独立入口为 `python -m entrypoints.voiceprint_sampler start`，使用下文的
`PYTHONPATH` 配置及已有 LiveKit 连接配置。后端与 worker 同时配置
`MEETING_VOICEPRINT_ENABLED=true`、`MEETING_VOICEPRINT_SAMPLING_ENABLED=true`、相同的
`MEETING_VOICEPRINT_SAMPLING_AGENT_NAME`（例如 `meeting-voiceprint`）及独立
`MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN`；worker 的
`AGENT_BACKEND_API_URL` 指向受控内部后端根地址。

采样服务使用独立 `Dockerfile.sampler` 和带哈希的 Linux Python 3.13 依赖锁；
不安装转写插件、Torch、Silero 或模型权重。支持 `start`（也是默认模式）
和离线 `--check`，拒绝 `dev`、`console`、`connect`，不调用通用 SDK CLI。
`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`、采样 token 可用同名 `*_FILE`
读取绝对路径的 Secret 文件，不能同时提供值和文件。采样 token 必须与
LiveKit 密钥及普通 agent token 分离。后端 HTTPS 私有 CA 可用
`VOICEPRINT_SAMPLER_BACKEND_CA_FILE`；LiveKit WSS 使用系统信任链，
不能把此变量当作 LiveKit 私有 CA 配置。

`VOICEPRINT_SAMPLER_MAX_ROOMS` 默认 1（1–8），
`VOICEPRINT_SAMPLER_JOB_MEMORY_MB` 默认 256（128–2048）。无预热池，
每房间独立进程，待接收任务也计入容量。SIGTERM 排空 45 秒，关闭最多
10 秒。私有 TCP 8094 只提供 `/health/live`、`/health/ready`、`/metrics`；
日志只有固定事件与严重级别，指标只有总数，没有房间／用户标签；SDK HTTP
仅绑定 loopback。就绪表示已注册 LiveKit，不代表已获准采样。

功能、agent name 和 token 在后端均默认关闭或为空。后端只为本人授权和
连接声明符合条件的真实房间实例派发；worker 默认不订阅音轨，每条源必须
取得并持续复验短期许可。参与者可见，禁止发布媒体／数据。PCM 仅在内存
保留当前短片段，超过队列、字节、时间或授权边界整段丢弃。

采样、候选入库和单人质检代码已接通；后端也已接通本人确认的通话基准、
跨会话设备组和贡献失效重建；来源物理清理、候选维护、派发持久恢复与
许可绑定的短期采样上报也已接通。后端独立 `voiceprint` worker 与 Celery Beat
需同时运行；可用 `dispatch_voiceprint_samplers --limit 20` 手工恢复派发。
agent 在有效第一帧后报告采样，关闭订阅后报告上传，缓冲擦除后报告停止；
状态上报逾 5 秒不更新即失效。Web／Android 通话界面、独立消费者与 sampler
Helm 资源已接通，完整后端 RTC 合成链路已通过，实际设备及生产验收继续开发。
`voiceprintSampler.enabled` 默认关闭，要求消费者和私有配置已接通，
并显式声明 LiveKit 信令／RTC／TURN 网络出口；业务双开关仍须另行启用。
构建及原生合成 RTC 证据见
[采样运行走查](../../docs/research/voiceprint-sampler-runtime-review-2026-10-11.md)。
真实后端、签名 webhook、Beat、本人声明和加密模板的可复现合成联调见
[完整 RTC 走查](../../docs/research/voiceprint-full-rtc-review-2026-10-11.md)；ASR 为本地协议 fixture，不能据此判断真人声纹效果。
使用 `--media-boundaries` 可复现实际容量不足后的空派发恢复、原生静音、
显式恢复、轨道替换和新 participant SID 重建，见
[媒体边界走查](../../docs/research/voiceprint-rtc-media-boundaries-review-2026-10-11.md)。
当前不在生产启用。兼容性与验证见
[采样管线走查](../../docs/research/voiceprint-call-pipeline-review-2026-10-10.md)及
[设备组模板走查](../../docs/research/voiceprint-device-templates-review-2026-10-10.md)及
[派发与状态走查](../../docs/research/voiceprint-dispatch-status-review-2026-10-11.md)。

## 本地环境与启动

在本目录执行 `uv sync --locked --all-extras`，并为当前终端配置源码搜索路径：

```powershell
# PowerShell，在 src/agents 下执行
$env:PYTHONPATH = (Resolve-Path ./src).Path
uv run python -m entrypoints.multi_user_transcriber dev
```

```bash
# Bash，在 src/agents 下执行
export PYTHONPATH="$PWD/src"
uv run python -m entrypoints.multi_user_transcriber dev
```

以下命令均在上述环境下运行；生产容器已设置 `PYTHONPATH=/app/src`，
Compose 和 Helm 使用相同的模块入口。

| 能力 | 生产命令 | 配置示例（相对仓库根目录） |
| --- | --- | --- |
| 会议原文转写 | `python -m entrypoints.multi_user_transcriber start` | `env.d/development/multi_user_transcriber.dist` |
| 会议元数据 | `python -m entrypoints.metadata_collector start` | `compose.yml` 的 `metadata-collector-dev` |
| AI 助手 | `python -m entrypoints.ai_assistant start` | Helm 的 `agentAIAssistant` |
| 私人翻译 | `python -m entrypoints.qwen_translation_agent start` | `env.d/development/meeting_translation.dist` |
| 共享同传 | `python -m entrypoints.qwen_interpretation_agent start` | 同上，另配置同传 agent 名称 |
| 会后录音转写 | `python -m entrypoints.capture_transcriber` | `env.d/development/capture_transcriber.dist` |
| 实时录音转写 | `python -m entrypoints.capture_live_transcriber` | 同上 |
| 录音翻译网关 | `python -m entrypoints.capture_translation_gateway` | `env.d/development/capture_translation.dist` |

LiveKit worker 本地开发使用 `dev` 替代 `start`。录音 worker 与网关没有该参数。
各入口仍是独立进程，需按能力分别部署。实际密钥通过运行环境或 Secret 注入。

Qwen Omni 客户端默认使用 `qwen3.8-omni-flash-realtime` 和 `Tina` 音色，
依赖 DashScope SDK ≥ 1.26.5。使用 3.8 时必须设置 `DASHSCOPE_WORKSPACE_ID`；
`DASHSCOPE_REGION` 默认为 `cn-beijing`，也支持 `ap-southeast-1`。
API Key 必须对应所选地域与业务空间。后端显式传入的模型和音色仍优先于客户端默认值。
部署时同步发布后端并执行迁移 `0195_upgrade_qwen_omni_38`，将旧 Qwen profile
切换到 3.8 及其 56 个音色。仍受支持的默认音色按名称保留，其余回退为 Tina；
旧模型与音色记录保留但停用，客户端缓存的旧音色 ID 会回退到 profile 默认值。
回滚数据库迁移会保留升级后的目录；回退模型需显式调整目录配置。

Android「AI 助手 → 打电话」统一使用 Qwen 3.8，语音与视频共用音色、提示词配置。
后端目录接口的 `model_code` 用于精确选择该模型，需与 Android 客户端同步发布。
一对一电话使用 Android → Omni 的 WebRTC 音视频轨道，不创建 LiveKit 房间或 worker。
后端 `POST /api/v1.0/ai-call/session/` 使用用户登录态鉴权、校验配置并代理 SDP 交换，
需要配置 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 和 `DASHSCOPE_REGION`。
API Key 只保留在后端。摄像头开关不重建会话；关闭摄像头会解绑视频轨道并停止采集。
会议内的 AI 助手仍通过 LiveKit worker 与 Omni WebSocket 通信。

Android「AI 助手 → 双语互译」复用录音翻译网关，音频经网关处理，
不创建会议。网关使用 Silero VAD 切分双方轮流说话的语音，先交给
`qwen3.8-omni-flash-realtime` 在用户选择的两种语言之间判断方向，再将完整原始音频
仅发送至对应目标语言的 `qwen3.8-livetranslate-flash-realtime` 会话。
方向识别直接使用音频，不依赖 LiveTranslate 转写事件中的 `language` 字段。

支持任意选择两种可输出「音频 + 文本」的语言，默认中文与英语：
`zh en ar de fr es pt id it ko ru th vi ja tr hi ms nl ur nb sv da he fi pl is cs fil fa`。
仅支持文本输出的语种（如粤语 `yue`）不出现在双语互译选项中。
会话开始后锁定语言组合；选择另一侧的语言时交换两侧，避免同语种互译。
Omni 只返回所选语种之一或 `unknown`，不会把其他语言强行归入该组合。
双语助手使用独立的音频语言白名单，不改变录音翻译和会议翻译的
`QWEN_TRANSLATION_LANGUAGES` 配置。

每句话保留 250 ms 前缀；从约 800 ms 音频开始识别，每增加 400 ms 重试，
首次明确识别出所选语种之一后即锁定方向并开始转发，不再等待第二次确认。
分类器一旦输出完整候选语言代码就立即返回，不再等待该响应的
`text.done` / `response.done` 尾部；输出其他内容时仍走原路径等待完成事件，保持不猜测方向。
两个翻译通道并行建连；收音前提前准备一个空的 Omni 识别会话，
将建连和会话配置移出每句识别的等待路径。每次识别仍使用独立会话，
不复用上一句上下文；识别完成立即转发音频，旧连接在后台限时关闭，
同时准备下一次识别。每通会话最多保留一个待用连接和一个正在关闭的连接。
待用连接超过 30 秒则在使用前丢弃；空闲连接失效时仅重连一次，
仍受原有识别总超时限制，挂断时取消预连接并释放所有连接。
只有未确定的音频继续探测；短句在结束时仍允许一次最终判断，已有明确结果不会被句尾重复识别覆盖。
最多用前 10 秒音频识别，仍不确定则提示未识别语种，不猜测方向。
Omni 分类使用独立的纯文本输出会话；LiveTranslate 3.8 保持服务端 VAD，
每句话结束时补静音触发翻译。未选中的方向只接收静音保活。
识别处理与手机上传 ACK 分离，待处理音频上限为 15 秒。识别超时、网络中断及
HTTP 429/部分 5xx 可在后续探测中恢复，默认连续失败三次才结束会话；成功请求会
清零计数。短句最终探测失败时只跳过该句，不猜测方向。鉴权、协议错误和积压超限
仍结束会话。播放译音时暂停语音输入的现有行为保持不变。

双语互译网关可通过以下环境变量调节识别（启动会话时校验，均有默认值）：

| 变量 | 默认值 | 范围 |
| --- | --- | --- |
| `TRANSLATION_LID_PROBE_MS` | 800 | 200–3000 ms |
| `TRANSLATION_LID_RETRY_MS` | 400 | 200–2000 ms |
| `TRANSLATION_LID_MAX_FAILURES` | 3 | 1–5 次 |
| `TRANSLATION_LID_TIMEOUT_MS` | 4000 | 1000–5000 ms |
| `TRANSLATION_TURN_SILENCE_MS` | 1000 | 300–2000 ms |

首个探针从 `TRANSLATION_LID_PROBE_MS` 开始，重试间隔由 `TRANSLATION_LID_RETRY_MS` 决定。
一句话短于该值时，方向识别整段落在句尾之后，所以短句（“好的”“谢谢”）的响应时间对这两个
变量最敏感；调小能提前锁定，代价是单词级音频的分类准确率下降，需用中英短句回归后再上线。

`TRANSLATION_TURN_SILENCE_MS` 同时决定 `session.update` 的
`audio.input.turn_detection.silence_duration_ms` 和句尾补发的静音长度，两者始终一致。
它直接落在「说完话到开始翻译」的关键路径上，但前提是 3.8 确实按该字段收尾：
先用 600 ms 试跑并对比 `translation_first_audio`，确认生效后再下调；只缩短补发静音
而不改会话字段不会让翻译提前开始。

网关进程启动即预加载 Silero 权重，单次会话把 VAD 加载与两条翻译通道的握手放进同一个
TaskGroup 并发完成，连接阶段不再串行等待模型初始化。

网关仅对双语翻译相关 logger 开启 INFO 诊断：本地语音开始/结束、语种识别耗时、
方向锁定、首段译音、交付门（`translation_audio_delivered`）、整句译文就绪和
未识别语种的句数（`translation_language_unknown`）；不记录语音、文字内容或凭证。
每条双语日志附带该前台连接的 `session=`（8 位随机十六进制，仅用于区分同一进程内
的并发会话，与票据、账号和内容无关），因此多用户并发时也能按会话还原延迟；
没有该字段的旧日志按顺序配对，并发下会失真。
短句停在“正在聆听”时，可据此区分本地 VAD 未触发、上游未输出和结果关联未完成。
此路由修复只需更新 agents 镜像并发布 `meet-agent-capture-translation`，兼容现有 APK。

最终原文在播报前进行方向校验：优先使用服务端明确返回的语种；缺失时，
仅用日语假名、韩文等有明显区别的文字特征检查所选语言组合。
共享汉字、拉丁字母、人名及混合语言不强行改判，原译文相同也不单独作为错误依据。
发现方向冲突后丢弃原通道的文字和音频，使用已接入的
`qwen3.8-omni-flash-realtime` 在独立会话中按正确方向补译最终原文，返回译文及语音。
正常句不增加模型调用；异常句会有额外延迟。每个方向最多同时补译两句，
每句限 2000 字、12 秒请求时间和 30 秒输出音频，不自动重试。
补译失败或仍明显未翻译时提示语种未识别，不播放错误结果，也不终止后续收音。
退出会话取消补译任务；日志只记录方向冲突、补译成功或失败，不记录会话文字。

仅在没有正在发送的语音、待完成回复或待关联译文时，尝试恢复空闲翻译连接。
每个方向在一次会话内共用三次重连额度，退避 0.2/0.5/1 秒，单次恢复总限时 6 秒。
恢复期间手机 ACK 不受握手阻塞；不重放语音。若两句话的处理重叠，无法确认上游
是否已消费全部音频，该方向保守禁用自动重连；停止、退出或结束会话也禁止重连。

日志记录 `language_probe`（识别请求耗时）、`language_selected`（从本地 VAD
开始到方向锁定）、`translation_first_audio`（从开始转发到收到首个译音事件），
以及识别连续失败次数、连接恢复次数和固定错误码，不记录原音频、转写或密钥。
客户端 `error` 事件附带安全白名单内的 `code`，保持旧版 APK 兼容。

首段译音延迟按三段拼接，全部只有时长、语言代码和固定错误码：

| 段 | 日志 | 口径 |
| --- | --- | --- |
| 上游首段译音 | `translation_first_audio elapsed_ms` | 本句首帧转发到收到首个译音事件 |
| 方向交付门 | `translation_audio_delivered gate_ms` | 译音已到网关到真正发给手机 |
| 手机播放 | App `translation_playback_started` | `queue_ms` 收到到首帧写入；`reply_ms` 本机最后一帧话音到首帧写入 |

`since_speech_ms` 是同一句从本地 VAD 起点到发出的时长；下一句已开始或跨句重叠时会失真，
此时以 `gate_ms` 与 App 侧 `reply_ms` 为准。上行往返见 App 每 100 帧采样一次的
`translation_ack_rtt_ms`。播放预缓冲与回声保护尾的取值见 Android 侧 README。

网关日志换算成分位数、A/B 判定规则、已记录的生产基线及并发边界见
[evaluations/bilingual_latency/README.md](evaluations/bilingual_latency/README.md)；
汇总脚本只依赖标准库，可直接读 `kubectl logs`。判断句尾窗口是否生效要看
`translation_first_audio` 的 p90/p95 与 `speech_end->result_ready`，不能只看 p50。

双语互译复用网关的 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、
`DASHSCOPE_REGION`，该空间需可调用上述两个模型。Silero 已包含在现有依赖中。
启用 29 种语言选择需要先发布后端票据校验及 agents 镜像（更新
`meet-agent-capture-translation`），再安装新版 Android APK；无需数据库迁移。
旧版 APK 仍可继续使用默认中英互译。方向识别会增加模型调用和等待时间；
识别耗时已通过首个完整语言代码即锁定、预连接和并发启动压缩。

原根目录的 `python <worker>.py` 已迁移为上述模块命令，自定义启动脚本需要同步更新。
外部评估或探测脚本也使用同一 `PYTHONPATH`，不在代码中修改 `sys.path`。

## 验证

配置上述源码路径后，在本目录运行：

```bash
uv run python -m unittest discover -s tests -t .
uv run ruff format . --check
uv run ruff check .
```

单元测试使用合成音频和假供应商；网关测试会建立本机 WebSocket 连接。
GitHub Actions 的 `test-agents` 作业执行同一测试命令，并独立于 lint 作业运行。

质量语料与评分说明见 [evaluations/asr_quality/README.md](evaluations/asr_quality/README.md)；
双语互译的延迟基线与采集方式见
[evaluations/bilingual_latency/README.md](evaluations/bilingual_latency/README.md)。
评估目录不进入 Docker 镜像；供应商评估必须显式使用 `--execute`。
