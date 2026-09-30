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
