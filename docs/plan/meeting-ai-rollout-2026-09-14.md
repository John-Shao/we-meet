# 会议 AI 配置启用与重新发布（2026-09-14）

用户部署后 Web 没有新入口、Android 录音按钮灰色。只读检查线上 `/api/v1.0/config/` 证实 `meeting_records.enabled`、`capture_audio_enabled`、`summary_requests_enabled` 都为 false；Android 入口由默认关闭的 BuildConfig 控制。用户已明确要求修改配置开启新功能。

## 已修改

- `src/helm/env.d/aliyun-prod/values.meet.yaml` 显式开启 26 项会议能力及既有 `RECORDING_ENABLE`：统一记录、录音/转写、三阶段总结、修订/任务/问答/文档/通知/分享、云录制和翻译。仅文字模式仍检查实际存储是否允许彻底删除，版本化桶不因开关开启而绕过该检查。
- 线上原文 Agent 切到 `qwen-audio-3.0-asr-flash-streaming`，总结为 `qwen3.8-flash`，翻译为 `qwen3.5-livetranslate-flash-realtime`。旧字幕翻译关闭，译文由独立翻译能力按用户选择处理，正式原文与译文分开。
- 开启 5 类 AI Worker，配置已有镜像仓库、内部 API `http://meet-backend`（Service 端口为 80）、中英模型与北京区域、`wss://meet.we-meet.online/capture-translation`、现有 `meet-tls` 和准确 Origin。
- 新增独立单副本 `celeryBeat`，使用 Recreate 更新策略，继承后端镜像和环境；调度总结、收尾及清理。将生产文件中未被模板使用的 `celery` 改为实际的 `celeryBackend`，消费 `meet-backend` 队列；环境合并不再修改后端原配置。
- Helm 从现有私密 values 中的助手 DashScope key、后端内部令牌及字幕 Agent LiveKit 凭据生成 `meet-ai-credentials`，由 API/新 Worker/字幕 Agent 引用。Secret 在迁移 hook 前创建并保留供工作负载使用。没有增加或提交任何密钥值；已有外部 Secret 的其他部署可保持 `credentialsFromExistingEnv=false`。
- Android 的受版本管理 `gradle.properties` 开启全部 5 个新增原生能力，覆盖构建脚本的关闭默认值。其他构建机不需要复制本机 `local.properties`；但显式本地覆盖仍优先。

通用 Helm 默认值仍关闭新增组件；本项目 `aliyun-prod` 已按用户授权显式开启。本次改动只准备并提交发布配置，没有修改正在运行的集群。

## 重新发布

**后续修正：** 首次配置启用遗漏了 Qwen ASR 必需的 `DASHSCOPE_WORKSPACE_ID`，导致两个录音 ASR Worker 启动退出，并阻塞整个 Helm release 的就绪等待。现已将该字段纳入发布前校验。详见 [ASR 缺少业务空间导致发布超时](meeting-ai-asr-rollout-timeout-2026-09-14.md)。此前“实际 values 渲染成功”仅验证了当时的模板，不代表 ASR 运行时配置完整。

在构建机拉取 Meet 的 `aliyun-dev` 最新提交，并按既有环境运行：

```bash
bash deploy/aliyun/build-and-push.sh backend agents
```

在部署主机拉取相同提交，保留现有私密 `values.secrets.yaml`，发布相同镜像 tag：

```bash
bash deploy/aliyun/release-meet.sh --tag <本次构建的提交号> backend agents
```

发布脚本会应用生产 values、运行既有数据库迁移 hook、更新 API/Celery/Beat/Agent，并等待对应 Deployment。服务端、Celery 和 Beat 使用相同能力配置。此次没有 Web 源码改动，已部署上一轮最新 Web 时无需再构建前端；部署后必须整页刷新，重新获取公开配置。

现有私密 values 须包含 `agentAIAssistant.envVars.DASHSCOPE_API_KEY`、`agentAIAssistant.envVars.DASHSCOPE_WORKSPACE_ID`、`backend.envVars.AGENT_INTERNAL_API_TOKEN`、`agentSubtitles.envVars.LIVEKIT_API_SECRET`，字幕 Agent 内部令牌与后端一致。业务空间必须与已开通的 Qwen ASR 服务及所选地域对应。远端若缺少必要字段，Helm 在渲染时明确报错。不要将私密 values 或完整 Helm 调试输出上传到版本库。

Android 拉取 `main`（本次启用提交 `e1475978`），按原构建流程重新打包安装。若 `local.properties` 有同名 false，它优先于 `gradle.properties`，应移除或改为 true。仅重启已安装 App 不会改变编译时开关。

## 部署后确认

1. `/api/v1.0/config/` 中 `meeting_records.enabled`、`capture_audio_enabled`、`summary_requests_enabled` 均为 true。
2. Web 整页刷新后可见 AI 录音、会议笔记、智能纪要；App 安装新版后录音按钮可点、笔记/纪要入口可见。
3. `meet-celery-backend`、`meet-celery-beat` 和 `meet-agent-{translation,interpretation,capture-asr,capture-live-asr,capture-translation}` 就绪；字幕 Agent 使用 Qwen，网关入口可建立鉴权 WSS。
4. 用测试账号发起录音/采集，再验证 ASR、总结、任务、Docs/IM 和译音；仅开启能力不会替用户发起录音、自动生成或分享。云录制仍需环境中实际运行的 LiveKit Egress；这里只开启 Meet 控制与已有录制配置，不安装独立 Egress 服务。

验证结果：11 项 Helm/脚本 fixture 检查通过、通用 Helm lint 通过；实际生产 values 与本地私密 values 在内存中渲染成功，API/Worker/Beat 开关、Secret 和内部令牌一致性通过，未输出凭据。Android Debug APK 构建和设计规范检查通过，5 项 BuildConfig 确认为 true。未执行线上部署、真实模型调用或真实通知。
