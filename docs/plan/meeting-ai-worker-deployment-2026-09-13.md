# AI Worker 部署配置与联调入口

这份说明供部署测试使用。代码和渲染检查已完成，不代表已部署或通过真实模型验收。所有新增 Worker、后端能力和 Android 入口默认关闭。

## 运行组件

| Helm worker key | 进程 | 对应能力 |
| --- | --- | --- |
| `translation` | `qwen_translation_agent.py start` | 线上私人翻译 |
| `interpretation` | `qwen_interpretation_agent.py start` | 线上同传频道 |
| `capture-asr` | `capture_transcriber.py` | 独立录音会后转写 |
| `capture-live-asr` | `capture_live_transcriber.py` | 独立录音实时转写 |
| `capture-translation` | `capture_translation_gateway.py` | 独立录音同传／双向语音翻译 |

原有 `multi_user_transcriber.py` 负责线上正式原文。API、Celery Backend、Beat、总结 Worker、上述按需启用的 Agent 必须使用兼容版本。独立实时和会后 ASR 是不同进程，不能只部署其中一个却同时开启两类任务。

## Helm 配置

将以下结构合并到测试环境的现有 values，按要测的能力开启对应 Worker；示例中的主机、仓库、不可变 tag 和 Secret 名均需替换。不要将真实 Secret 内容写入版本库。

```yaml
meetingAIWorkers:
  image:
    repository: registry.example.invalid/team/meet-agents
    tag: REPLACE_WITH_COMMIT
  credentialsSecret: meet-ai-credentials
  backendUrl: http://meet-backend:8000
  livekitUrl: wss://livekit.example.invalid
  workers:
    translation:
      enabled: false
    interpretation:
      enabled: false
    capture-asr:
      enabled: false
    capture-live-asr:
      enabled: false
    capture-translation:
      enabled: false
  gateway:
    origins: https://meet.example.invalid
    ingress:
      enabled: false
      className: nginx
      host: meet.example.invalid
      tlsSecret: meet-tls
```

`credentialsSecret` 包含 `AGENT_INTERNAL_API_TOKEN`、`DASHSCOPE_API_KEY`，可选 `DASHSCOPE_WORKSPACE_ID`；线上两类 Agent 另需 `LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`。模板通过 `secretKeyRef` 注入，独立录音 Worker 不注入 LiveKit 凭据。内部令牌必须与后端一致。模型区域通过各 Worker 的 `envVars` 配置，并与后端冻结到任务的区域相同。

录音翻译入口固定为 `wss://<host>/capture-translation`，后端实际配置名是 **`MEETING_CAPTURE_TRANSLATION_URL`**。Ingress 为 Exact 路径，不能附加重写前缀、查询参数或把 ticket 放入 URL。启用内置 Ingress 时要求 TLS Secret；可使用外部 WSS 代理代替内置 Ingress。浏览器 Origin 使用逗号分隔的显式允许列表；Android 不发送 Origin，仍必须完成短期 ticket 鉴权。Ingress 的空闲超时需允许长连接；客户端心跳和后端租约另行约束会话。

部署脚本 `release-meet.sh agents` 会为所有可选 Worker 指定本次不可变 tag，但不会开启禁用的 Worker。部分发布保留已存在 Worker 的镜像 tag；不存在的 Worker 保留 values 中显式指定的 tag。缺少集群读取权限会使发布停止。滚动更新可能中断活动翻译；客户端显示中断，用户显式重新开始，不自动续播旧音频。建议无活动录音／翻译时更新。

## 后端与客户端联动

- 应用完整迁移链至 `0178_capture_translation_archives`（以仓库迁移实际名称为准），先在测试库演练。不要只迁移最后两项。
- 在线翻译：`MEETING_TRANSLATION_ENABLED`，`ROOM_TRANSLATION_AGENT_NAME=meeting-translation`；频道同传另需 `MEETING_INTERPRETATION_ENABLED`、`ROOM_INTERPRETATION_AGENT_NAME=meeting-interpretation`。
- 独立录音：记录、采集协议、音频保存开关；会后 ASR 为 `MEETING_CAPTURE_ASR_ENABLED`，实时 ASR 另需 `MEETING_CAPTURE_LIVE_ASR_ENABLED`。
- 独立翻译：`MEETING_CAPTURE_TRANSLATION_ENABLED`、上述 WSS URL、`MEETING_CAPTURE_TRANSLATION_REGION`；译文保存另需 `MEETING_TRANSLATION_ARCHIVE_ENABLED` 和本次用户同意。
- 仅保留文字另需 `MEETING_CAPTURE_TEXT_ONLY_ENABLED`、兼容的私有对象存储、清理任务及 Beat。不要跳过存储探测。
- 总结使用 `MEETING_SUMMARY_MODEL=qwen3.8-flash`；实时／最终、人工编辑、任务、文档、通知、分享、问答开关按交接清单逐项开启，配置应同步到执行相应工作的 Celery 进程。
- Android 打包时按需开启 `WE_MEET_CAPTURE_NATIVE`、`WE_MEET_CAPTURE_TRANSLATION_NATIVE` 等现有能力开关；服务端开关不能代替原生构建开关。

本地 Compose 增加 `interpretation`、`capture-live-asr`、`capture-translation` 可选 profile。录音翻译示例为 `env.d/development/capture_translation.dist`，复制后的文件已被忽略。8093 只绑定宿主回环地址；客户端仍要求本地 TLS 代理提供 WSS。

## 部署后验证

先确认 Agent 注册／轮询和网关 readiness，再由测试账号显式发起会话。覆盖原录音继续、两个语言方向、尾段、停止、断线、后台、换账号、撤权和已保存译文分页。音频播报用耳机测试，并实测蓝牙／音频焦点和回灌。记录各操作延迟、来源 ID、错误状态及资源释放；不要记录凭据或 WS 音频正文。

关闭新增能力开关会禁止新任务；先结束已有会话再缩容。保留已生成内容和幂等记录，已有结果仍通过原权限读取。完整备份、迁移演练、模型质量和真实负载验收由部署测试阶段完成。
