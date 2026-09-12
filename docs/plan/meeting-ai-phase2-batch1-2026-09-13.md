# 会议 AI 阶段 2：第一批（累计第七批）

日期：2026-09-13。基线：`d1bb3a1f`。实现 C01 的可配置 Qwen 实时 ASR 适配和 Agent 对接；阶段 1 待部署验收项不因此自动完成。部署和实际业务音频测试由用户负责。

## 实现

- `STT_PROVIDER=qwen` 走 QwenSTT；保留原 deepgram/kyutai/doubao 配置回退。模型默认候选 `qwen-audio-3.0-asr-flash-streaming`，用 QWEN_ASR_MODEL 覆盖。业务质量仍待测试，不宣称最终选型质量验收已完成。
- 每个参会者独立 STT 流和供应商 task_id。只对非空 final 写正式原文；SDK 简化字幕事件继续可用，但不再次落库。原文 ingest_id 由供应商任务 UUID 和 sentence_id 确定，HTTP 重试保留；重复 final 去重，内容变更冲突报错。
- 保存真实返回的句子 begin/end 偏移，转换为入站音频观察时间；不再把模型返回时刻作为句子时间。PCM 到达用单调时钟记录间隔，超过 250 ms 的明显输入中断保留在时间映射中，null 结束偏移保持 null。时间精度属于 Agent 入站观察，尚非设备采样时钟或精确媒体定位证明。
- 真实 LiveKit SpeechStream 负责重采样至 16 kHz 单声道 PCM。待处理音频最多 10 秒，溢出或非单声道显式失败；不静默丢帧。关闭先 end_input 排空，再等待 finish-task 的 task-finished，超时标记文字送达不完整。
- 没有 PCM 不连接供应商；5 秒无新输入时正常收尾当前任务，有真实输入后创建新任务，避免静音麦克风空连接超时。不伪造静音填充。累计源偏移跨任务保留；每个新任务有独立 ingest 身份。
- 禁止 SDK 自动重放部分消费过的源音频；连接错误以 sanitized 错误上报，并调用现有 writer.mark_incomplete。暂未实现失败任务的音频持久重放。暂停/空闲正常换任务与网络错误不是同一种结果。
- WSS 仅允许已配置 workspace 和北京/新加坡地域；拒绝 HTTP 重定向，密钥不出现在 repr、异常正文或日志。provider/model/凭据配置在每个参会者 STT 实例创建时固定。

协议按官方 [WebSocket API](https://www.alibabacloud.com/help/en/model-studio/fun-asr-realtime-websocket-api)、[客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)、[服务端事件](https://help.aliyun.com/en/model-studio/fun-asr-server-events) 核对：等 task-started 才送音频，发 finish-task 后继续接尾句，task-finished 才是该任务正常结束。这里的任务结束仍不等于整场会议音频覆盖完整。

## 部署配置（由用户执行）

Agent 环境设置 STT_PROVIDER=qwen、ENABLE_SILERO_VAD=False、DASHSCOPE_API_KEY、DASHSCOPE_WORKSPACE_ID、QWEN_ASR_REGION=cn-beijing、QWEN_ASR_MODEL=qwen-audio-3.0-asr-flash-streaming。密钥使用现有 Secret 管理方式，不写入仓库。参考 `env.d/development/multi_user_transcriber.dist`；该文件只是示例，未改实际运行环境。

正式原文送达账本还要求 Agent 的 AGENT_TRANSCRIPT_DELIVERY_ENABLED=true 以及后端 MEETING_RECORDS_ENABLED、MEETING_TRANSCRIPT_DELIVERY_ENABLED；Agent 原有 AGENT_BACKEND_API_URL、AGENT_INTERNAL_API_TOKEN 仍需配置。一个会议只启动一个正式原文 Agent，不同时运行新旧 provider 写入同一来源。

websockets 最低版本提高至 15.0，以使用明确禁用代理的连接参数；uv.lock 保持既有 16.0，uv 0.10.9 重新解析并通过 lock --check。没有升级其他依赖。

建议实测：开始时静音后开麦、长静音恢复、多人交替、结束时最后一句、网络异常、关闭重入和中英混合。检查准确会议场次、原文起止时间、重复写入与不完整状态。旧翻译配置仍使用原服务，这批没有切换语音翻译模型或自动发送消息。

## 检查与走查

23 项 Agent 单元/SDK 集成测试通过（原 13 项 + 新增 10 项），覆盖协议握手、尾句、重复/冲突 final、错误脱敏、task 范围、超时/取消、输入时间间隔、真实 48 kHz→16 kHz 重采样、重复关闭、静音恢复、SDK 字幕去重与时间落库。走查/测试修复了“任务刚结束时输入已关闭但队列仍有音频”的漏读竞态：现在确认队列为空才退出。

新增插件与测试 Ruff 通过；transcriber 除原有两处 PLC0415 条件 import 外通过，新增源事件辅助函数显式标注参数数量例外。没有后端/页面改动，不重复无关后端/前端构建。本批没有真实模型收费调用、部署或多端实测；阶段 0 连通记录不能代替新适配的上线质量验收。

下一批把供应商任务收尾观察和错误原因保存到后端，供源详情与纪要读取，不将 task-finished 升格为整场完整性证明。随后继续阶段 2 的实时/速记/完整纪要和页面，最后统一做技术评审与代码走查，修复发现的问题再交由用户部署测试。
