# 会议 AI：批次 16，翻译协议基础

状态：协议实现与隔离测试通过；尚未接入会议调度或开放产品入口。

## 本批交付

- 新增 `src/agents/plugins/qwen_live_translate.py`，复用旧项目的 Workspace 实时协议约定，未复制其广播、身份和历史保存逻辑。
- 模型默认 `qwen3.5-livetranslate-flash-realtime`。服务端读取 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`DASHSCOPE_REGION`、`QWEN_TRANSLATION_MODEL`；显式语言开关 `QWEN_TRANSLATION_LANGUAGES` 默认 `zh,en`。这是适配层允许值，产品入口仍未开放。
- 区分供应商 60 种输入/文本目标与 29 种音频目标；文本目标不能错误创建译音会话。支持 server VAD 与 Manual commit；Manual 不发送 `response.create`、不提交空缓冲。
- 分别接收 `response.text.*` 和 `response.audio_transcript.*`。预测 stash 独立保存；片段 done 仍是候选，只有 response completed 才交付正式译文。中断、未完成响应或缺失最终文本均不伪报成功。
- 源 ASR 默认关闭，启用时也只输出 source candidate；目标与源 item 的关联单独输出，不写第二套正式原文。响应 usage 只提取有界非负整数 token 字段，不记录任意上游内容。
- PCM 输入 16 kHz 单声道 S16，每次最多 1 秒；输出 24 kHz，每段最多 1 秒。WebSocket 队列 4 帧、单帧上限 128 KB；同步等待消费回调，消费超过 5 秒中止。待完成响应、文本和 ID 均有界。
- 停止等待 `session.finished`，且此前事件消费回调已完成；20 秒尾段期限后如实失败。禁止自动重连/音频重放，拒绝凭据重定向，关闭代理自动发现；配置 repr 不包含密钥，错误仅固定代码。

## 验证

新增 15 项模拟测试，覆盖文本与音频能力、未完成响应、最终文本修订、重复事件、来源关联、非法音频、缓冲限制、慢消费者、尾段等待、超时、空提交、取消和资源释放。

Agent 全部测试 **52 项通过**。未调用真实模型，未读取实际密钥，未做设备音频测试。

## 接续范围

下一批实现翻译会话的服务端授权、代次和幂等控制，之后连接原始音轨与授权译文/译音分发。当前不能宣称同传或双向语音翻译已可部署使用。内部上报、usage 持久化、前端面板和设备质量验证仍待完成。

协议核对：2026-09-13，[模型说明](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)、[客户端事件](https://help.aliyun.com/zh/model-studio/live-translator-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/live-translator-server-events)。
