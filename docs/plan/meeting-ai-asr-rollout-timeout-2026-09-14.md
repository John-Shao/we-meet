# ASR 缺少业务空间导致发布超时（2026-09-14）

## 已确认的现场状态

- Helm revision 312、313 等待 10 分钟后失败，但新 backend、celery-backend、celery-beat Pod 均已 Ready；事件证实 `61cd5291` 镜像可正常拉取，使用它的 docs-profiles Job 也执行成功。
- capture-asr 与 capture-live-asr 两个 Deployment 持续 CrashLoopBackOff，各重启 38 次。这两个服务早于本次 backend 发布就已异常。
- 读取同一 AI Secret 的运行中容器确认：`api_key_configured=True`、`workspace_configured=False`。
- `QwenASRConfig` 要求 API Key 和有效的 workspace ID。两个 ASR Worker 启动时立即加载配置，缺少 ID 时在任何任务领取或模型调用前退出；旧日志仅显示“worker stopped”，没有可操作的原因。
- `release-meet.sh backend` 保留其他模块的镜像标签，但依旧对整个 chart 执行 `helm upgrade --wait --timeout 10m`；未选择更新的 ASR Deployment 不就绪仍会阻塞发布。脚本没有 `--atomic`，Helm 报错不等于已回滚所有更新。
- reminders 的旧 Job 使用 `e82fce7b` 镜像并已卡住 19 天，应另行检查 CronJob 当前模板和过期执行，不能将它的拉取失败解释为 `61cd5291` 镜像缺失。本批不删除旧 Job。

## 修复与验证

1. Helm 管理 AI Secret 时，只要启用录音 ASR 或 Qwen 字幕，渲染阶段就要求 `agentAIAssistant.envVars.DASHSCOPE_WORKSPACE_ID` 为非空字符串并通过与 ASR 相同的字符校验。外部管理的 Secret 不读取明文，但 ASR 对该 key 的引用改为必填。
2. 翻译类 Worker 的 workspace 引用继续可选；ASR 和生产 Qwen 字幕使用必填引用。桶权限、用户授权及 ASR 请求协议不改变。
3. 两个 ASR 入口复用启动函数，明确记录 `dashscope_workspace_id_missing`、`dashscope_api_key_missing` 等固定错误码，未知异常只输出通用码，避免泄露密钥、原文或供应商响应。
4. 配置示例与部署说明修正“workspace 按需”的遗漏。

验证：38 项 ASR 单元测试、13 项 Helm 配置测试、Ruff 和 diff 空白检查通过。没有调用真实模型、领取生产任务或操作集群。真实 workspace ID 尚待操作方提供，不以虚构值绕过启动检查。

## 操作方恢复步骤

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
