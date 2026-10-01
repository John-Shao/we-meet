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

网关仅对双语翻译相关 logger 开启 INFO 诊断：本地语音开始/结束、语种识别耗时、
方向锁定、首段译音、原文完成和译文送达；不记录语音、文字内容或凭证。
短句停在“正在聆听”时，可据此区分本地 VAD 未触发、上游未输出和结果关联未完成。
此路由修复只需更新 agents 镜像并发布 `meet-agent-capture-translation`，兼容现有 APK。

仅在没有正在发送的语音、待完成回复或待关联译文时，尝试恢复空闲翻译连接。
每个方向在一次会话内共用三次重连额度，退避 0.2/0.5/1 秒，单次恢复总限时 6 秒。
恢复期间手机 ACK 不受握手阻塞；不重放语音。若两句话的处理重叠，无法确认上游
是否已消费全部音频，该方向保守禁用自动重连；停止、退出或结束会话也禁止重连。

日志记录 `language_probe`（识别请求耗时）、`language_selected`（从本地 VAD
开始到方向锁定）、`translation_first_audio`（从开始转发到收到首个译音事件），
以及识别连续失败次数、连接恢复次数和固定错误码，不记录原音频、转写或密钥。
客户端 `error` 事件附带安全白名单内的 `code`，保持旧版 APK 兼容。

双语互译复用网关的 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、
`DASHSCOPE_REGION`，该空间需可调用上述两个模型。Silero 已包含在现有依赖中。
启用 29 种语言选择需要先发布后端票据校验及 agents 镜像（更新
`meet-agent-capture-translation`），再安装新版 Android APK；无需数据库迁移。
旧版 APK 仍可继续使用默认中英互译。方向识别会增加模型调用和等待时间。

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

质量语料与评分说明见 [evaluations/asr_quality/README.md](evaluations/asr_quality/README.md)。
评估目录不进入 Docker 镜像；供应商评估必须显式使用 `--execute`。
