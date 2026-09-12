# 阶段 2 第八批（累计第十四批）：Agent 执行与会中采集按钮

承接第十三批在线采集控制，完成 Web → 精确场次控制 → LiveKit dispatch → Agent 认领 → 心跳 → 尾段收齐 → 结束确认的代码接线。云录制不受开始／结束文字记录操作影响。

## 实现

- 会中“会议笔记”增加文字记录状态与开始／结束按钮；即使尚未生成第一句原文也能开始。仅有当前控制权限的用户显示按钮，已有记录的授权读者可见运行状态；撤权后清除缓存显示。
- starting、recording、stopping、stopped、incomplete 分别显示。停止后等待 Agent 确认，不能提前显示已结束；失败重试复用相同操作键和 run ID，后续状态查询也失败时仍可重试不确定操作。
- Agent 消费后端 dispatch 的 delivery UUID 和 LiveKit SID，在准确场次认领独占进程 UUID。首次心跳确认 recording 后才启动 ASR；停止已先到达则直接收尾空运行，不启动模型。注册失败不再回退旧无账本写入。
- 心跳每 2 秒进行，单次 HTTP 超时 3 秒，连续 15 秒无法确认控制状态则停止采集并标记 incomplete。停止时持续心跳直到真实 drain 与完成上报结束；显式停止与框架退出共用一次收尾锁。
- 重复 managed dispatch 使用独立 SFU 身份，落败进程由数据库认领拒绝，不会先挤掉正在运行的连接。旧字幕启动入口也不再并行加入已有 managed Agent；原文采集排除 Agent 和 Egress 音轨，为译音防回流提供基础。
- 内部转写与心跳 HTTP 禁止跟随重定向，防止共享凭据被转发到另一地址。

## 验证与边界

Agent 全部 37 项单元测试通过，覆盖进程身份贯穿原文／尾段、认领失败、错场次、重复调度、网络失联、收尾续租、并发退出、机器人音轨和 HTTP 回包验证；均无真实模型调用。Web 会中记录与控制 9 项测试通过，TypeScript、ESLint、变更范围 Ruff 和生产构建通过。构建仍有既存 Marianne/Devise SVG 运行期解析及大包提示。

后台控制与 Agent 必须同时升级后，再开启 `MEETING_ONLINE_CAPTURE_ENABLED`、`MEETING_RECORDS_ENABLED`、`MEETING_TRANSCRIPT_DELIVERY_ENABLED`，并运行 Celery Beat。正常旧字幕链路可继续保持原配置；managed dispatch 强制启用送达认领，不依赖 Agent 的旧可选账本开关。生产 ASR 使用阶段 0/2 已登记的 Qwen 配置，实际密钥仍由部署注入。

尚未进行真实 LiveKit/麦克风/模型端到端验收。下一批继续补“结束记录但会议继续”的速记与完整纪要时机、面向参会者的采集状态提示，以及控制边界的技术走查。独立录音、Android 对齐和翻译流水线仍在后续计划内，不将本批描述为全部阶段开发完成。
