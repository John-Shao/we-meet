# 会议 AI：批次 18，私人音轨翻译 Agent

状态：真实 SDK 接线及模拟测试完成；Web 面板进入下一批，真实音频由用户部署后验证。

## 实现

- 新增 `qwen_translation_agent.py`。仅接收经过校验的调度引用，连接指定会议 SID，以独立 job 身份加入，领取服务端独占 worker 后才连接 Qwen；重复调度无法重复调用模型。
- 禁用自动订阅。只订阅后端授权的真人连接及其麦克风，校验 identity + participant SID + kind；排除 Agent、屏幕音频与其他设备。来源离开或换轨中止，不把重连当作原授权继续采集。
- 发布前调用 LiveKit 订阅权限：`allow_all_participants=false`，仅允许该来源连接身份收听。译文使用可靠数据包且明确 destination，不回退到全房间广播。每个事件携带 run_id、generation、direction。
- 连续模式一条 server VAD 翻译流；按键模式两条固定语言对的 Manual 流，以实际数据包发送者校验开始/结束命令。音频和 commit 在同一 FIFO 排序；按键轮次完成后才接收下一轮，避免两方向译音混播；未收到响应 30 秒失败，按键模式无操作 60 秒释放。
- 复用 SDK 重采样为 16 kHz 单声道；消费层音频 FIFO 最多 1 秒、命令最多 100 条，溢出终止并标记失败。源 SDK 流由独立轻量读取循环持续取帧，未声称证明网络/设备完整采样。
- 译音 24 kHz、播放缓冲 200 ms。停止立即清空播放队列，正常停止且授权仍有效时只继续交付尾段文字；权限撤销/心跳失败立即停止输出。双通道尾段并行收齐，完成回执包含实际观测 token 使用量，未知保留 null。
- 数据包超过 14 KB 明确失败，不截断文字或伪报完整。当前是短句即时翻译；大段长文本分包及持久译文归档尚未实现。
- 清理异常仍尝试释放资源、关闭 watcher 并提交失败回执；未建原文、总结或录音文件，也不将译音回写转写通道。

## 运行配置

使用已有 agents 镜像，生产进程命令为 `python qwen_translation_agent.py start`。它需要单独 worker，不能覆盖现有转写 worker 的命令。

新增开发示例 `env.d/development/meeting_translation.dist`（复制到同目录 `meeting_translation` 并填写秘密配置；实际文件已被 git 忽略）。Compose 使用可选 `translation` profile，命令 `docker compose --profile translation up meeting-translation-dev`。本批未实际启动联网 worker。

Agent 与后端 `ROOM_TRANSLATION_AGENT_NAME` 必须一致；后端还需启用 `MEETING_TRANSLATION_ENABLED` 和既有 Celery 定时处理。密钥留在 Agent 环境，未写入文档或代码。用户进行正式部署，新增 Kubernetes worker 配置将随最终部署交接补齐。

## 检查

Agent **64 项测试通过**（新增 12 项），验证订阅 ACL 先于发布、私人译文接收者、来源 SID/代次、拒绝重复 claim、双向 FIFO、音频上限、空按键解锁、取消及清理异常。后端翻译 **16 项通过**，包括正常停止授权尾段与撤权停止不分发。

测试使用当前镜像的 LiveKit SDK、模拟网络和音频，不代表回声消除、实机收听、延迟或语言准确率已验收。接续 Web 控制/译文阅读后，再扩展多人频道和独立录音关联。
