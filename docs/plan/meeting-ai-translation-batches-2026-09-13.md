# 会议 AI 翻译：第 1–4 批执行记录

整理日期：2026-09-22。

收录累计批次 16–19 的协议、会话授权、音轨 Agent 与 Web 入口；模型选型方案独立保留。

本文件按原批次 / 日期合并，保留原文、验证记录和当时状态，仅调整标题层级与文档链接。正文中的“本批”“下一批”“已通过”均为历史记录，不代表本次重新验证或当前部署状态。原文件名用于追溯；阶段内批次与累计批次沿用原编号。

[返回方案目录](README.md)

## 目录

- [会议 AI：批次 16，翻译协议基础](#translation-batch1)
- [会议 AI：批次 17，翻译会话授权与控制](#translation-batch2)
- [会议 AI：批次 18，私人音轨翻译 Agent](#translation-batch3)
- [会议 AI：批次 19，Web 私人语音翻译入口](#translation-batch4)

---

<a id="translation-batch1"></a>

来源：`meeting-ai-translation-batch1-2026-09-13.md`。

## 会议 AI：批次 16，翻译协议基础

状态：协议实现与隔离测试通过；尚未接入会议调度或开放产品入口。

### 本批交付

- 新增 `src/agents/plugins/qwen_live_translate.py`，复用旧项目的 Workspace 实时协议约定，未复制其广播、身份和历史保存逻辑。
- 模型默认 `qwen3.5-livetranslate-flash-realtime`。服务端读取 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`DASHSCOPE_REGION`、`QWEN_TRANSLATION_MODEL`；显式语言开关 `QWEN_TRANSLATION_LANGUAGES` 默认 `zh,en`。这是适配层允许值，产品入口仍未开放。
- 区分供应商 60 种输入/文本目标与 29 种音频目标；文本目标不能错误创建译音会话。支持 server VAD 与 Manual commit；Manual 不发送 `response.create`、不提交空缓冲。
- 分别接收 `response.text.*` 和 `response.audio_transcript.*`。预测 stash 独立保存；片段 done 仍是候选，只有 response completed 才交付正式译文。中断、未完成响应或缺失最终文本均不伪报成功。
- 源 ASR 默认关闭，启用时也只输出 source candidate；目标与源 item 的关联单独输出，不写第二套正式原文。响应 usage 只提取有界非负整数 token 字段，不记录任意上游内容。
- PCM 输入 16 kHz 单声道 S16，每次最多 1 秒；输出 24 kHz，每段最多 1 秒。WebSocket 队列 4 帧、单帧上限 128 KB；同步等待消费回调，消费超过 5 秒中止。待完成响应、文本和 ID 均有界。
- 停止等待 `session.finished`，且此前事件消费回调已完成；20 秒尾段期限后如实失败。禁止自动重连/音频重放，拒绝凭据重定向，关闭代理自动发现；配置 repr 不包含密钥，错误仅固定代码。

### 验证

新增 15 项模拟测试，覆盖文本与音频能力、未完成响应、最终文本修订、重复事件、来源关联、非法音频、缓冲限制、慢消费者、尾段等待、超时、空提交、取消和资源释放。

Agent 全部测试 **52 项通过**。未调用真实模型，未读取实际密钥，未做设备音频测试。

### 接续范围

下一批实现翻译会话的服务端授权、代次和幂等控制，之后连接原始音轨与授权译文/译音分发。当前不能宣称同传或双向语音翻译已可部署使用。内部上报、usage 持久化、前端面板和设备质量验证仍待完成。

协议核对：2026-09-13，[模型说明](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)、[客户端事件](https://help.aliyun.com/zh/model-studio/live-translator-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/live-translator-server-events)。

---

<a id="translation-batch2"></a>

来源：`meeting-ai-translation-batch2-2026-09-13.md`。

## 会议 AI：批次 17，翻译会话授权与控制

状态：服务端控制与隔离测试完成；真实音轨、译音订阅权限和前端接线进入下一批。

### 范围与边界

- 新增迁移 `0158_meeting_translation_control`：独立翻译运行和幂等命令回执，不创建会议笔记、云录制或正式原文。
- 每个运行固定会议场次、发起人、来源连接、组织、代次、模式、语言对及模型。首批中英、主持人/管理员自己的在线真人音轨、本人私有接收。多人公共频道及其他来源授权尚未开放。
- `GET/POST /api/v1.0/meeting-translations/control/` 使用普通用户身份和当前房间管理权限；加入令牌及资料分享不授予控制权。GET 只返回本人运行及本人在线来源连接。
- 启动要求 `key`、`expected_run_id`、`source_participation_id`、`source`、`target`、`mode`（`simultaneous`/`push_to_talk`）和 `audio`；停止只接受命令及当前运行 ID。重复键返回原回执和当前状态，改变意图或使用过期运行 ID 返回冲突。
- 一人同场仅一个活跃运行。切换先停止旧运行，等待尾段确认后创建新代次；旧运行命令不能控制新代次。
- `POST /api/agent/translations/control/` 通过内部令牌校验，claim 在连接供应商之前独占 worker；后续 heartbeat/finish 校验 worker、场次和代次。只在 translating 时提供来源和私人接收身份，停止后停止返回分发参数。
- 来源断开、删除、改为 Agent、管理权限撤销或组织改变进入 stopping。未领取 60 秒、worker 心跳失联 30 秒、停止收尾 30 秒均转 incomplete；迟到的完成不能覆盖超时。
- 完成要求供应商 finished 和本地消费完成两项确认，回执重复提交不重复处理、内容改变返回冲突。usage 未观察到时允许 null，不把未知消耗伪填为 0。
- 持久 starting 行用于重试 LiveKit 调度，15 秒最短重试；领取后不再重调度，避免重复模型连接。沿用后台 tick，关闭新功能开关后仍处理既有运行退出。

### 默认配置

`MEETING_TRANSLATION_ENABLED=false`；`ROOM_TRANSLATION_AGENT_NAME` 默认空。只有显式配置 worker、开启功能和 Celery 才允许启动；真实 worker 尚待下批接线，当前勿开放给用户。

### 验证与评审

16 项新测试覆盖本人来源、外人/跨场次拒绝、幂等、并发启动单一成功、重复 worker、过时代次、权限撤销、来源消失、停止与切换、完成回执和超时。连同既有会中采集和总结自动化回归，共 **39 项通过**。

检查中修复组织为空及来源删除后的模型校验问题、嵌套回执未知字段校验问题。迁移仅用于本地隔离数据库，迁移一致性检查通过；未部署、未调用付费模型。

这轮是批次检查。全部功能开发结束后仍需执行用户要求的整体技术评审和代码走查。

---

<a id="translation-batch3"></a>

来源：`meeting-ai-translation-batch3-2026-09-13.md`。

## 会议 AI：批次 18，私人音轨翻译 Agent

状态：真实 SDK 接线及模拟测试完成；Web 面板进入下一批，真实音频由用户部署后验证。

### 实现

- 新增 `qwen_translation_agent.py`。仅接收经过校验的调度引用，连接指定会议 SID，以独立 job 身份加入，领取服务端独占 worker 后才连接 Qwen；重复调度无法重复调用模型。
- 禁用自动订阅。只订阅后端授权的真人连接及其麦克风，校验 identity + participant SID + kind；排除 Agent、屏幕音频与其他设备。来源离开或换轨中止，不把重连当作原授权继续采集。
- 发布前调用 LiveKit 订阅权限：`allow_all_participants=false`，仅允许该来源连接身份收听。译文使用可靠数据包且明确 destination，不回退到全房间广播。每个事件携带 run_id、generation、direction。
- 连续模式一条 server VAD 翻译流；按键模式两条固定语言对的 Manual 流，以实际数据包发送者校验开始/结束命令。音频和 commit 在同一 FIFO 排序；按键轮次完成后才接收下一轮，避免两方向译音混播；未收到响应 30 秒失败，按键模式无操作 60 秒释放。
- 复用 SDK 重采样为 16 kHz 单声道；消费层音频 FIFO 最多 1 秒、命令最多 100 条，溢出终止并标记失败。源 SDK 流由独立轻量读取循环持续取帧，未声称证明网络/设备完整采样。
- 译音 24 kHz、播放缓冲 200 ms。停止立即清空播放队列，正常停止且授权仍有效时只继续交付尾段文字；权限撤销/心跳失败立即停止输出。双通道尾段并行收齐，完成回执包含实际观测 token 使用量，未知保留 null。
- 数据包超过 14 KB 明确失败，不截断文字或伪报完整。当前是短句即时翻译；大段长文本分包及持久译文归档尚未实现。
- 清理异常仍尝试释放资源、关闭 watcher 并提交失败回执；未建原文、总结或录音文件，也不将译音回写转写通道。

### 运行配置

使用已有 agents 镜像，生产进程命令为 `python qwen_translation_agent.py start`。它需要单独 worker，不能覆盖现有转写 worker 的命令。

新增开发示例 `env.d/development/meeting_translation.dist`（复制到同目录 `meeting_translation` 并填写秘密配置；实际文件已被 git 忽略）。Compose 使用可选 `translation` profile，命令 `docker compose --profile translation up meeting-translation-dev`。本批未实际启动联网 worker。

Agent 与后端 `ROOM_TRANSLATION_AGENT_NAME` 必须一致；后端还需启用 `MEETING_TRANSLATION_ENABLED` 和既有 Celery 定时处理。密钥留在 Agent 环境，未写入文档或代码。用户进行正式部署，新增 Kubernetes worker 配置将随最终部署交接补齐。

### 检查

Agent **64 项测试通过**（新增 12 项），验证订阅 ACL 先于发布、私人译文接收者、来源 SID/代次、拒绝重复 claim、双向 FIFO、音频上限、空按键解锁、取消及清理异常。后端翻译 **16 项通过**，包括正常停止授权尾段与撤权停止不分发。

测试使用当前镜像的 LiveKit SDK、模拟网络和音频，不代表回声消除、实机收听、延迟或语言准确率已验收。接续 Web 控制/译文阅读后，再扩展多人频道和独立录音关联。

---

<a id="translation-batch4"></a>

来源：`meeting-ai-translation-batch4-2026-09-13.md`。

## 会议 AI：批次 19，Web 私人语音翻译入口

状态：Web、后端与 Agent 协议已接线，模拟检查和前端完整构建通过；未进行真实模型或设备验收。

### 用户流程

会议「更多工具 → 语音翻译」提供连续翻译和按键中英双向翻译，可选仅译文或译文+译音。入口按后端当前权限和开关显示，默认不开启；用户明确开始才创建运行。

首批来源是用户自己的当前会议麦克风，译文/译音本人接收。页面明确说明按键只控制翻译输入，会议原声仍按会议麦克风状态发送；不会自动打开麦克风，不会启动云录制。这是私人语音翻译增量，不等同于多人会议同传频道。

切换语言前停止旧运行，收齐尾段后才可新建；操作响应不确定时复用原始请求键及配置。暂停收听只静音，不停止模型；停止操作立即本地静音，再等待服务端确认。另一设备的运行可停止，但不允许从当前设备注入音频。

### 实现与限制

- 会话 Provider 持续挂载在 LiveKit 会场内，侧栏切换不重启模型；用户、房间、场次或运行变化清空对应译文和控制状态。
- 仅接受实际 Agent 发送者、对应 run_id/generation 的译文；首次有效 Agent 身份固定，旧代次和其他参与人的事件丢弃。预测文本覆盖更新，正式译文不回退为 partial；最多保留最近 60 段，尚未保存到笔记。
- 数据和音轨权限仍由 Agent/LiveKit 服务端限制；前端额外在未知就绪状态、来源设备不符、停止、状态查询失败或离开时静音。恢复页面默认静音，需要用户主动收听。
- Agent 新增 sync 回应，恢复按键命令序号、输入方向和等待状态；不会为恢复侧栏重建供应商连接。按键使用连续序号、同一个发送队列，上一轮结束前不接受下一方向；指针取消、键盘释放、窗口失焦、麦克风关闭和侧栏退出会结束当前按键输入。
- 修复会议笔记入口遗留的中文问号乱码和英文标点问题。

### 验证

新增 Web **12 项测试**：事件来源/代次/大小验证、partial/final、60 段上限、按键释放、另一设备控制、显式开始、立即静音、未确认请求重试、故障状态下停止和私有指令顺序。既有笔记与会中采集 **9 项回归通过**。

Agent **64 项**、后端翻译 **16 项**通过。ESLint、Ruff、JSON 解析（115 文件）和 `npm run build` 通过。构建保留此前的 Marianne/Devise 静态资源解析提示与大 chunk 提示，无新构建错误。

后续继续多人同传、独立录音、资料工作区和跟进闭环；真实语言质量、音轨权限效果、端到端延迟及扬声器回声需要用户部署后实测。完整开发完成后仍要执行整体技术评审和代码走查。
