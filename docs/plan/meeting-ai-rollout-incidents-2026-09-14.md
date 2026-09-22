# 会议 AI 配置启用与发布故障记录（2026-09-14）

整理日期：2026-09-22。

收录配置启用、ASR 业务空间遗漏与录音上传 OOM 修复。保留当时的命令、部署顺序、验证和限制。

本文件按原批次 / 日期合并，保留原文、验证记录和当时状态，仅调整标题层级与文档链接。正文中的“本批”“下一批”“已通过”均为历史记录，不代表本次重新验证或当前部署状态。原文件名用于追溯；阶段内批次与累计批次沿用原编号。

[返回方案目录](README.md)

## 目录

- [会议 AI 配置启用与重新发布（2026-09-14）](#meeting-ai-rollout)
- [ASR 缺少业务空间导致发布超时（2026-09-14）](#meeting-ai-asr-rollout-timeout)
- [AI 录音上传中断：后端 OOM 修复（2026-09-14）](#meeting-ai-audio-upload-oom)

---

<a id="meeting-ai-rollout"></a>

来源：`meeting-ai-rollout-2026-09-14.md`。

## 会议 AI 配置启用与重新发布（2026-09-14）

用户部署后 Web 没有新入口、Android 录音按钮灰色。只读检查线上 `/api/v1.0/config/` 证实 `meeting_records.enabled`、`capture_audio_enabled`、`summary_requests_enabled` 都为 false；Android 入口由默认关闭的 BuildConfig 控制。用户已明确要求修改配置开启新功能。

### 已修改

- `src/helm/env.d/aliyun-prod/values.meet.yaml` 显式开启 26 项会议能力及既有 `RECORDING_ENABLE`：统一记录、录音/转写、三阶段总结、修订/任务/问答/文档/通知/分享、云录制和翻译。仅文字模式仍检查实际存储是否允许彻底删除，版本化桶不因开关开启而绕过该检查。
- 线上原文 Agent 切到 `qwen-audio-3.0-asr-flash-streaming`，总结为 `qwen3.8-flash`，翻译为 `qwen3.5-livetranslate-flash-realtime`。旧字幕翻译关闭，译文由独立翻译能力按用户选择处理，正式原文与译文分开。
- 开启 5 类 AI Worker，配置已有镜像仓库、内部 API `http://meet-backend`（Service 端口为 80）、中英模型与北京区域、`wss://meet.we-meet.online/capture-translation`、现有 `meet-tls` 和准确 Origin。
- 新增独立单副本 `celeryBeat`，使用 Recreate 更新策略，继承后端镜像和环境；调度总结、收尾及清理。将生产文件中未被模板使用的 `celery` 改为实际的 `celeryBackend`，消费 `meet-backend` 队列；环境合并不再修改后端原配置。
- Helm 从现有私密 values 中的助手 DashScope key、后端内部令牌及字幕 Agent LiveKit 凭据生成 `meet-ai-credentials`，由 API/新 Worker/字幕 Agent 引用。Secret 在迁移 hook 前创建并保留供工作负载使用。没有增加或提交任何密钥值；已有外部 Secret 的其他部署可保持 `credentialsFromExistingEnv=false`。
- Android 的受版本管理 `gradle.properties` 开启全部 5 个新增原生能力，覆盖构建脚本的关闭默认值。其他构建机不需要复制本机 `local.properties`；但显式本地覆盖仍优先。

通用 Helm 默认值仍关闭新增组件；本项目 `aliyun-prod` 已按用户授权显式开启。本次改动只准备并提交发布配置，没有修改正在运行的集群。

### 重新发布

**后续修正：** 首次配置启用遗漏了 Qwen ASR 必需的 `DASHSCOPE_WORKSPACE_ID`，导致两个录音 ASR Worker 启动退出，并阻塞整个 Helm release 的就绪等待。现已将该字段纳入发布前校验。详见 [ASR 缺少业务空间导致发布超时](meeting-ai-rollout-incidents-2026-09-14.md#meeting-ai-asr-rollout-timeout)。此前“实际 values 渲染成功”仅验证了当时的模板，不代表 ASR 运行时配置完整。

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

### 部署后确认

1. `/api/v1.0/config/` 中 `meeting_records.enabled`、`capture_audio_enabled`、`summary_requests_enabled` 均为 true。
2. Web 整页刷新后可见 AI 录音、会议笔记、智能纪要；App 安装新版后录音按钮可点、笔记/纪要入口可见。
3. `meet-celery-backend`、`meet-celery-beat` 和 `meet-agent-{translation,interpretation,capture-asr,capture-live-asr,capture-translation}` 就绪；字幕 Agent 使用 Qwen，网关入口可建立鉴权 WSS。
4. 用测试账号发起录音/采集，再验证 ASR、总结、任务、Docs/IM 和译音；仅开启能力不会替用户发起录音、自动生成或分享。云录制仍需环境中实际运行的 LiveKit Egress；这里只开启 Meet 控制与已有录制配置，不安装独立 Egress 服务。

验证结果：11 项 Helm/脚本 fixture 检查通过、通用 Helm lint 通过；实际生产 values 与本地私密 values 在内存中渲染成功，API/Worker/Beat 开关、Secret 和内部令牌一致性通过，未输出凭据。Android Debug APK 构建和设计规范检查通过，5 项 BuildConfig 确认为 true。未执行线上部署、真实模型调用或真实通知。

---

<a id="meeting-ai-asr-rollout-timeout"></a>

来源：`meeting-ai-asr-rollout-timeout-2026-09-14.md`。

## ASR 缺少业务空间导致发布超时（2026-09-14）

### 已确认的现场状态

- Helm revision 312、313 等待 10 分钟后失败，但新 backend、celery-backend、celery-beat Pod 均已 Ready；事件证实 `61cd5291` 镜像可正常拉取，使用它的 docs-profiles Job 也执行成功。
- capture-asr 与 capture-live-asr 两个 Deployment 持续 CrashLoopBackOff，各重启 38 次。这两个服务早于本次 backend 发布就已异常。
- 读取同一 AI Secret 的运行中容器确认：`api_key_configured=True`、`workspace_configured=False`。
- `QwenASRConfig` 要求 API Key 和有效的 workspace ID。两个 ASR Worker 启动时立即加载配置，缺少 ID 时在任何任务领取或模型调用前退出；旧日志仅显示“worker stopped”，没有可操作的原因。
- `release-meet.sh backend` 保留其他模块的镜像标签，但依旧对整个 chart 执行 `helm upgrade --wait --timeout 10m`；未选择更新的 ASR Deployment 不就绪仍会阻塞发布。脚本没有 `--atomic`，Helm 报错不等于已回滚所有更新。
- reminders 的旧 Job 使用 `e82fce7b` 镜像并已卡住 19 天，应另行检查 CronJob 当前模板和过期执行，不能将它的拉取失败解释为 `61cd5291` 镜像缺失。本批不删除旧 Job。

### 修复与验证

1. Helm 管理 AI Secret 时，只要启用录音 ASR 或 Qwen 字幕，渲染阶段就要求 `agentAIAssistant.envVars.DASHSCOPE_WORKSPACE_ID` 为非空字符串并通过与 ASR 相同的字符校验。外部管理的 Secret 不读取明文，但 ASR 对该 key 的引用改为必填。
2. 翻译类 Worker 的 workspace 引用继续可选；ASR 和生产 Qwen 字幕使用必填引用。桶权限、用户授权及 ASR 请求协议不改变。
3. 两个 ASR 入口复用启动函数，明确记录 `dashscope_workspace_id_missing`、`dashscope_api_key_missing` 等固定错误码，未知异常只输出通用码，避免泄露密钥、原文或供应商响应。
4. 配置示例与部署说明修正“workspace 按需”的遗漏。

验证：38 项 ASR 单元测试、13 项 Helm 配置测试、Ruff 和 diff 空白检查通过。没有调用真实模型、领取生产任务或操作集群。真实 workspace ID 尚待操作方提供，不以虚构值绕过启动检查。

### 操作方恢复步骤

在构建机和部署服务器的现有 `src/helm/env.d/aliyun-prod/values.secrets.yaml` 中，向已有的 `agentAIAssistant.envVars` 增加字段，不要重复追加同名顶级 YAML 块或覆盖既有 API Key：

```yaml
agentAIAssistant:
  envVars:
    DASHSCOPE_WORKSPACE_ID: "实际的 ASR 业务空间 ID"
```

这里展示的是应合入的字段；示例中文不能作为实际值。必须使用与 ASR 服务、API Key 授权及地域对应的真实 ID。当前由此字段生成共享 `meet-ai-credentials`，并注入两个 ASR Worker 和字幕 Agent。

本批有 agents 运行时代码变化，需要在构建机拉取最新 `aliyun-dev` 后构建 agents：

```bash
git pull --ff-only origin aliyun-dev
export IMAGE_TAG="$(git rev-parse --short HEAD)"
bash deploy/aliyun/build-and-push.sh agents
```

服务器补齐私密 values 后拉取同一版本并发布对应标签：

```bash
git pull --ff-only origin aliyun-dev
bash deploy/aliyun/release-meet.sh --branch aliyun-dev --tag <刚构建的标签> agents
kubectl -n meet get deployments meet-backend meet-agent-capture-asr meet-agent-capture-live-asr
helm -n meet history meet --max 3
```

只发布 agents 会保留当前 backend 镜像。ASR 进入 Running 只证明配置及领取循环能启动，真实音频转写仍需录音测试验证。若仍退出，读取新的固定原因码：

```bash
kubectl -n meet logs deploy/meet-agent-capture-asr --tail=50
kubectl -n meet logs deploy/meet-agent-capture-live-asr --tail=50
```

若容器已重启，再尝试 `--previous`；旧容器日志已回收时应检查当前日志或等下一次启动，不能据此推断镜像缺失。无需删除 Helm 历史记录，也不要通过关闭两个 ASR 服务来将整套会议 AI 标记为已恢复。

---

<a id="meeting-ai-audio-upload-oom"></a>

来源：`meeting-ai-audio-upload-oom-2026-09-14.md`。

## AI 录音上传中断：后端 OOM 修复（2026-09-14）

### 现场证据

- 后端 Pod `meet-backend-7b7759f945-wl59q` 已重启 2 次，最近终止原因为 `OOMKilled`。
- 上一容器日志显示音频上传连续返回 200，随后日志中断；因此只查当前容器会看不到此前上传记录。
- 受影响录音处于 `stopping`、revision 3。数据库有 224 个分片记录，其中 223 个 `stored=True`，第 224 个 `stored=False`，尚无最终 manifest。
- 第 223 片回读及哈希校验成功（160044 字节）；第 224 片回读为 `FileNotFoundError`。桶中已有音频与 App 显示未完成保存并不矛盾，剩余分片仍需要补传。
- Android 恢复日志只显示前两页回执查询返回 200。该现象不能单独证明分页代码错误，也不能证明本地回执处理成功；若修复后仍停在第二页，继续定位客户端恢复过程。

### 修复

1. `capture_storage.audio_storage()` 原来每次调用都构建新的 S3Storage；首次 I/O 又创建 boto3 Session、S3 Resource 和服务模型。连续上传、回读与能力查询会反复分配较大的客户端对象图。
2. 改为每个进程的每个工作线程复用一个专用音频 Storage。Django 默认存储对象替换或进程 fork 后重建；不缓存用户权限、桶版本控制检查或音频保留期限。
3. 保留音频专用的私有 ACL、禁用 gzip、3 秒连接/10 秒读取超时及原重试限制，全局默认 Storage 配置不受影响。
4. Gunicorn 支持通过环境变量控制进程数和优雅回收。生产配置由 3 个进程改为 2 个，每个进程处理 500 个请求后回收，增加 0–50 个请求的随机偏移；继续使用原 1 GiB 内存限制。并发处理能力相应降低，部署后需观察接口延迟及内存。
5. Android 补充 302 分片、多页回执解析回归测试；本批没有 App 运行时代码变化，不需要因本修复重新安装 APK。

### 验证

- 后端音频上传、回读、文本模式、清理及存储复用测试：47 项通过。
- Helm 渲染与 Gunicorn 生产配置加载测试：12 项通过。
- Android CaptureRepository 测试：14 项通过，包含游标 `0 → 100 → 200 → 300` 的 302 分片恢复数据。
- Ruff、`git diff --check` 通过。

在隔离测试容器内，以真实 MinIO 连续上传并回读校验 302 个 5 秒 PCM WAV 分片（每片 160044 字节），逐片删除本次测试对象，完成后删除专用临时桶。测试使用显式本地测试凭证，未调用生产 OSS 或 AI 服务。两个模式在独立进程运行，未在循环中强制 GC，旧模式按此前逻辑逐片新建客户端，新模式复用客户端。

| 本地单进程测试 | 起始 RSS | 最终 RSS | 峰值 RSS | 302 片耗时 |
| --- | ---: | ---: | ---: | ---: |
| 逐片新建客户端 | 181.8 MiB | 458.7 MiB | 480.6 MiB | 35.75 秒 |
| 复用客户端 | 181.0 MiB | 186.2 MiB | 186.3 MiB | 7.40 秒 |

所有分片均完成字节数及 SHA-256 校验。这证实旧实现会显著增加内存占用，与生产 3 个工作进程共享 1 GiB 限制下出现的 OOM 一致。数值是本地单进程存储链路结果，不代表生产并发负载或公网 OSS 延迟；完整用户录音的恢复仍需部署后验证。

### 发布与恢复

本批需要重新构建后端镜像，并应用更新后的 Helm 生产 values。只调整旧镜像的环境变量不会读取新增 Gunicorn 配置。

在构建环境执行：

```bash
git checkout aliyun-dev
git pull --ff-only origin aliyun-dev
export IMAGE_TAG="$(git rev-parse --short HEAD)"
bash deploy/aliyun/build-and-push.sh backend
```

服务器拉取同一版本，使用刚构建的镜像标签：

```bash
bash deploy/aliyun/release-meet.sh --branch aliyun-dev --tag <刚构建的标签> backend
kubectl -n meet rollout status deployment/meet-backend --timeout=10m
kubectl -n meet exec deploy/meet-backend -- python -c 'import runpy; c=runpy.run_path("/usr/local/etc/gunicorn/meet.py"); print({k:c[k] for k in ("workers","max_requests","max_requests_jitter")})'
kubectl -n meet top pods
```

运行时配置应显示 `workers=2`、`max_requests=500`、`max_requests_jitter=50`。后端镜像同时供使用同一镜像的 Celery 服务使用，由发布脚本/Helm 更新。Web 和 agents 没有本批代码变化。

在原 App、原账号中打开这份未完成录音，点击“重试上传”，待上传量归零后点击“完成保存”。恢复协议先核对服务端回执，只补传未确认的原分片。第 224 片继续使用已登记的原序号与对象路径，不需要新建录音。

观察后端内存及 Pod 重启次数不再增长、后续分片上传成功、最终 manifest 创建且会话到达 `stopped`。保留 App 本地数据，直到完整保存得到确认；不要手工将 `stored` 字段改为 true，也不要提前封存缺片的录音。
