# 会议 AI 当前可部署测试范围（2026-09-13）

用户负责部署和实测，本文件记录开发侧现状。新开关默认关闭，尚未执行生产迁移或修改线上配置。累计第二十五批是阶段性增量，不是完整首版交付。

## 本轮建议测试

1. 同房间创建两场会议；开启在线文字采集，停止采集后继续开会，确认只有当前场次产生纪要。再次采集时旧生成任务不能写入新窗口。
2. 检查实时／速记／最终纪要状态、尾段超时和人工重试；原文引用与实际听到的时间对应关系需要真实音频核验。
3. 工具中的私人语音翻译：中英连续和按键双向、仅文本和译音、另一设备、停止及断网。按键只控制翻译输入，会议麦克风原声仍按原会议状态发送。
4. 人工修订、AI 重生成、两窗口并发编辑、查看历史及引用；共享只读用户不能修改。
5. 确认行动项内容／负责人／日期并创建任务；重复点击和丢响应不得重复创建。修改任务完成状态后纪要可读到新状态；删除任务后保留已转换记录。
6. 访客、同组织无资料权限用户、仅纪要权限用户和撤权用户检查读取边界；会中问答只允许当前场次的原文资料读者，不能用加入令牌读取历史材料。

## 迁移与运行组件

备份并按原部署流程执行 `python manage.py migrate --noinput`。本轮最新迁移为 `0163_capture_audio_storage`；先在测试库演练现有数据到最新版本。开发侧隔离数据库已执行通过。

后端 API、Celery Worker、Celery Beat、转写 Agent 与翻译 Agent 需要版本一致。后台 `core.tasks.summary_versions.tick_record_summaries` 负责生成调度、超时和采集／翻译恢复；不要只部署 API 而遗漏 Beat。真实 LiveKit Webhook 必须能投影准确场次与参与设备 SID。

转写 Agent 继续运行 `multi_user_transcriber.py`，`STT_PROVIDER=qwen`，`QWEN_ASR_MODEL=qwen-audio-3.0-asr-flash-streaming`；后端 `ROOM_SUBTITLE_AGENT_NAME` 必须匹配 Agent 的 `TRANSCRIBER_AGENT_NAME`。

私人翻译是独立 Worker：`python qwen_translation_agent.py start`。后端和 Agent 的 `ROOM_TRANSLATION_AGENT_NAME` 必须相同；现有镜像构建须包含新文件和更新的依赖锁。仓库有可选开发 compose profile，生产 Worker 需按现有运维部署方式添加，尚未替用户部署。

## 开关与模型

| 能力 | 后端开关／配置 |
| --- | --- |
| 统一记录 | `MEETING_RECORDS_ENABLED` |
| 送达账本与在线文字采集 | `MEETING_TRANSCRIPT_DELIVERY_ENABLED`、`MEETING_ONLINE_CAPTURE_ENABLED`、`CELERY_ENABLED` |
| 显式版本化生成 | `MEETING_VERSIONED_SUMMARY_ENABLED`、`MEETING_SUMMARY_REQUESTS_ENABLED` |
| 实时／速记／最终阶段 | `MEETING_STAGED_SUMMARY_ENABLED` |
| 用户主动开启自动总结 | `MEETING_SUMMARY_AUTOMATION_ENABLED` |
| 有限长文本分块 | `MEETING_SUMMARY_CHUNKING_ENABLED` |
| 私人语音翻译 | `MEETING_TRANSLATION_ENABLED`、`ROOM_TRANSLATION_AGENT_NAME`、`CELERY_ENABLED` |
| 人工修订 | `MEETING_SUMMARY_REVIEW_ENABLED` |
| 确认行动项转任务 | `MEETING_SUMMARY_TASKS_ENABLED`（同时需要人工修订和记录开关） |
| 原文快照问答 | `MEETING_RECORD_QA_ENABLED`（需要记录开关和当前原文读取权限） |
| 独立音频保存协议 | `MEETING_CAPTURE_AUDIO_ENABLED`、`MEETING_CAPTURE_PROTOCOL_ENABLED`（同时需要记录开关） |

总结为 `MEETING_SUMMARY_MODEL=qwen3.8-flash`，`MEETING_SUMMARY_BASE_URL` 按已选地区配置。翻译为 `QWEN_TRANSLATION_MODEL=qwen3.5-livetranslate-flash-realtime`，首批 `QWEN_TRANSLATION_LANGUAGES=zh,en`，`DASHSCOPE_REGION` 与 workspace 区域一致。

供应商与 Agent 令牌通过部署密钥注入：`DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`AGENT_INTERNAL_API_TOKEN`；Agent 的 `AGENT_BACKEND_API_URL` 指向可信后端，LiveKit 连接参数按环境注入。文档和提交均不保存密钥值。`env.d/development/meeting_translation.dist` 仅为开发示例，不可直接作为生产凭据。

## 不应作为本轮已完成能力验收

- 独立录音目前有控制、原文和真实 WAV 分片存储协议；浏览器采集、端到端续传、ASR、播放器和仅文字清理仍未闭环。
- 私人语音翻译尚不是多人／多语言频道同传，译文关联笔记和完整费用归集仍有后续工作。
- 新版独立文档与纪要助手推送尚未接入，需先解决 Docs 远程创建的幂等／结果查询依赖；旧版文档链路不代表新版已完成。
- 记录级 Qwen 问答已支持所选纪要原文快照及准确引用检查、私人提问恢复。当前为有界单轮，超过 250 KB 的原文明确拒绝，语义质量与长输入扩展仍待评测；不要将准确引用校验等同于答案内容全部正确。
- Android、新首页全部入口及跨终端状态对齐仍按总计划推进，不能以 Web 单元测试替代真机测试。

反馈时提供提交号、record/session 或 run ID、操作顺序、实际与预期、发生时间及终端环境即可；不要附带密钥。开发侧收到问题后按影响排序修复、验证、自动提交与推送。
