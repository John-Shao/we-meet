# 会议 AI：统一入口与 Qwen

## 用户入口

- 实时字幕继续保留；房间侧栏改为「问本场会议」，点击后展开，可一键提问讨论总结、结论和待办。
- 单份实录／纪要保留原有问答及来源引用。
- 移除 Web「我的会议 AI」悬浮窗；会议首页、实录与智能纪要提供 AI 搜索入口。
- Web 与 Android 的全局 AI 搜索支持「会议与录音」范围及开始／结束日期。只有点击提问才调用模型，修改范围会取消请求并清除旧答案。
- 搜索覆盖在线会议、独立录音和上传录音的已发布原文及最新纪要。人工修订优先于 AI 稿；来源链接打开对应实录、AI 版本或人工纪要。权限撤销会终止回答并清除客户端内容。

## 模型配置

| 用途 | 模型／配置 |
| --- | --- |
| 实时字幕 | `qwen-audio-3.1-asr-flash-streaming` |
| 非实时整段转写（包括上传文件） | `qwen-audio-3.1-asr-flash-filetrans` |
| 纪要、本场问答、实录问答、全局 AI 搜索 | `MEETING_SUMMARY_MODEL=qwen3.8-flash` |
| 字幕向量 | `QWEN_EMBEDDING_MODEL=text-embedding-v4`，1024 维 |
| 入会语音／视频 AI 助手 | Qwen-Omni；会议目录和启动接口均拒绝旧 Doubao 配置 |

2026-10-06 实时 ASR 升级为 3.1，沿用 WebSocket `run-task` / `finish-task` 协议与 16 kHz PCM 输入。Agent 19 项、后端 28 项回归测试通过，并使用线上凭证和合成英语音频验证了识别文本及任务结束确认。文件转写独立配置；历史验收记录保留原模型名。接口参考：[实时 ASR 客户端事件](https://help.aliyun.com/en/model-studio/qwen-audio-asr-streaming-client-events)。

同日文件 ASR 升级为 `qwen-audio-3.1-asr-flash-filetrans`，沿用异步 HTTP 提交、轮询及结果解析。Agent 6 项、后端 36 项、Summary 3 项回归测试通过；线上凭证与合成英语音频验证了句子文本和逐字时间信息，临时音频已删除。

文本及向量调用使用 `DASHSCOPE_API_KEY` 和 `MEETING_SUMMARY_BASE_URL`（默认百炼北京 OpenAI 兼容接口）。旧 `ARK_*`、`DOUBAO_*`、`GLOBAL_ASK_LLM_ENDPOINT` 不再决定这些会议调用。普通问答和 JSON 纪要关闭 Qwen 思考模式。

旧 summary 服务使用 `LLM_MODEL=qwen3.8-flash`、百炼 `LLM_BASE_URL` 及独立 `DASHSCOPE_API_KEY`。即使旧 secrets 文件仍有 `LLM_API_KEY`，Qwen 路径也不会读取这把旧钥匙。Helm 为 summary 和各 summary worker 复用 `meet-ai-credentials`。

## 旧索引和上线

- 仅同一 `embedding_model` 的向量参与相似度比较；模型名也隔离查询向量缓存。
- Doubao 旧向量仍保留在数据库，旧字幕通过关键词检索继续可用。新实录／上传原文及纪要按实时权限做关键词召回，无需向量重建即可搜索。
- 历史字幕向量重建是显式、计费操作，不在迁移或发布过程中自动执行。先在目标环境查看范围：

  ```sh
  python manage.py backfill_embeddings --all --dry-run
  python manage.py backfill_embeddings <session-uuid> --dry-run
  ```

  确认范围和费用后去掉 `--dry-run`。该命令只处理已有 session 字幕索引，不创建录音原文或重新转写文件。
- 旧个人问答 API 暂留供旧客户端兼容，默认模型同样为 Qwen；新界面统一使用 `search/ask-stream/`，请求增加 `scope`（`all`／`meetings`）和可选 ISO 日期 `date_from`／`date_to`。
- 部署需要发布 backend、summary、frontend 镜像及 Android 客户端，并使用本次 Helm values。验证环境不发起真实模型调用，也不重建线上索引。

接口参考：[百炼兼容接口](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[文本向量 API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)。


## 客户端 ASR 验证与云端连接复用（2026-10-06）

Android Debug APK 的个人录音页新增“实时转写直连（验证）”。录音开始后可以手动开启；仅复用现有 16 kHz PCM 采集，不启动第二个麦克风。开始前等待模型 task-started，停止后发送 finish-task 并等待最后一句与 task-finished。重复终句去重，音频队列和结果数量有上限，失败不自动重连或重放。退出前台、离开录音页或切换账号会关闭连接。与实时翻译共享同一 PCM 订阅槽，冲突会结束验证并显示错误。

验证字幕只在当前页显示，不进入实录、纪要或服务器日志；共同会议字幕及正式录音转写继续走云端。这是灰度验证入口，并非正式转写流程迁移。下一步是否替代个人录音实时预览，应在真机、弱网、蓝牙、长会话及后台切换验证后决定。

客户端通过已登录的 `POST /api/v1.0/assistant-transcription/session/` 获取 60 秒临时凭证，然后直接连接百炼工作空间 WebSocket，固定模型 `qwen-audio-3.1-asr-flash-streaming`。后端仅使用 Secret `meet-ai-credentials` 的 `DASHSCOPE_ASR_CLIENT_API_KEY`；未配置时返回 503，不回退全权限 Key。专用源 Key 应在百炼限制为该模型；临时凭证继承源 Key 权限。签发限制为每用户每分钟 10 次，响应禁止缓存，客户端禁用凭证日志和跨域跳转。参见[临时凭证文档](https://help.aliyun.com/zh/model-studio/application-obtain-temporary-authentication-token)。

本次实测 ASR 3.1 的 AOQ inference 分配返回 400 InvalidParameter（url error），同条件 ASR 3.0 分配成功。因此不降级模型，ASR 3.1 客户端验证采用 WebSocket；Omni 与 LiveTranslate 已有 AOQ 接入保持原实现。

云端 Filetrans 和 Embedding 使用线程内复用的 requests Session，进程变化后新建连接池。Authorization 始终按请求设置，清空供应商响应 Cookie，结果存储下载不携带模型凭证；关闭自动 HTTP 重试，保留异步任务账本和轮询，不将提交超时误当作可以重复收费提交的理由。Backend 的 qwen3.8-flash 继续使用 OpenAI 兼容 SDK，底层 httpx 连接池由每个 worker 进程共享；关闭一个 SDK 包装客户端不关闭其它任务正在使用的池。旧 Summary 的文件转写也复用线程内 Session；Agent 文件转写已有单任务内 aiohttp Session 复用，本轮未改为跨任务共享。

没有仅为池化而迁移到 DashScope SDK：Python 原生 HTTP 池和现有 SDK 的传输层即可复用连接，Java SDK 的内置池参数不能直接套用于 Python。参见[连接复用配置](https://help.aliyun.com/zh/model-studio/connection-multiplexing-configuration)。目前仍需通过生产负载指标评估池大小，未宣称已完成高并发压测。

验证：Backend 61 项测试、Summary 3 项测试、Android PCM 订阅单元测试、模拟器 3 项协议测试通过；模拟器使用演示账号及合成英语音频完成生产临时凭证与 ASR 3.1 WebSocket 直连，识别文本及结束确认成功。APK 构建与设计 token 检查通过。

## Android 个人录音正式直连转写（2026-10-07）

上述页面内验证入口升级为正式转写，适用于保留音频的个人录音。用户开始录音后手动开启“直连转写”，使用 `qwen-audio-3.1-asr-flash-streaming` 和既有专用 Key 签发的临时凭证直连百炼 WebSocket。共同会议字幕、仅保留文字的录音及云端整段转写仍使用既有流程。

连接与文字同步由麦克风前台服务持有，离开页面或进入后台不会结束转写。识别从连接完成并订阅 PCM 时开始，不回放开启前的音频；绝对时间位置以录音采集样本数为准。暂停时等待最后一句及模型结束确认，恢复录音后创建新的模型任务，仅发送续录音频。同一录音的多个识别任务汇入同一个正式转写代次。

已确认文字写入按账号隔离的本地加密待发送记录，使用固定句子 ID 和递增序号同步。结束录音或点击“停止并保存转写”后，服务器原子发布已确认文字到正式实录。停止并保存结束该录音的直连转写，客户端不再次创建仅包含后续片段的代次覆盖先前文字；需要继续识别时应使用录音暂停与续录。断网、进程重建和保存响应丢失时可以重试文字保存；不会自动重放音频、重启模型或触发额外云端转写。连接中断不停止原录音，恢复识别需要明确操作。原录音仍按原流程上传归档，因此此次优化减少的是服务器参与实时 ASR 的连接和音频处理，未取消录音归档流量。

后端新增设备与租约绑定的 `/capture-sessions/{capture}/transcription/direct/` 创建接口及 `.../direct/{job}/` 文字同步接口。复用现有转写任务及原文表，不需要数据库迁移；云端 Agent 不领取客户端任务。客户端内容仅标记为 `client_direct_asr` 来源，转写覆盖范围始终为 `partial`，纪要来源保留该标记；保存成功不代表整段录音均被识别，也不生成未经供应商确认的计费用量。需要完整文字时，用户可在录音结束后进入实录手动运行云端整段转写。

服务端开关为 `MEETING_CAPTURE_DIRECT_ASR_ENABLED`，默认关闭；生产 Helm 已启用，继续要求 `DASHSCOPE_ASR_CLIENT_API_KEY` 专用凭证。客户端转写与实时翻译共用一个 PCM 订阅槽，不并行调用两个实时音频工具。

验证：后端基础回归 52 项及最终直连、个人录音纪要、分阶段纪要测试 33 项通过。Android 7 项直连控制器、3 项协议、9 项采集服务测试及 PCM 单元测试通过，覆盖暂停续录、后台采集、网络保存失败后重建、回执丢失、连接中停止和账号撤销。生产端到端测试以合成英语音频完成两次真实模型识别、暂停续录、音频归档、正式原文读取及时间位置核对；测试记录已移入回收站。5 个后端部署已完成滚动更新，线上开关、路由及源码哈希核对通过。长时间真机、蓝牙和持续弱网验证仍需继续进行。
