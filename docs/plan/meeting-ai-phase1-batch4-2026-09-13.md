# 会议 AI 阶段 1：第四批执行记录

日期：2026-09-13。基线：`002db528`。本批完成转写送达账本与 Agent 收尾，M1 仍在进行中。

## 交付

- 迁移 0150：增加 TranscriptDelivery（单次 Agent 运行）和 TranscriptReceipt（连续序号、原文关联、载荷指纹）；MeetingTranscriptVersion 增加不可变 delivery 元数据。
- 新内部接口 `POST /api/agent/transcript-deliveries/` 注册、封存账本。使用现有 X-Agent-Token，必须提供准确 room_id / livekit_room_sid；只允许为已存在的 active 场次首次注册，重试不能改变场次。允许已注册运行在会议结束后补交尾句并封存。
- 原 `/api/agent/transcripts/` 增加可选 delivery_id / sequence，启用后要求二者、ingest_id 和 SID 全部存在。旧请求仍保持原协议。
- 同一场次串行写入，原文与 receipt 原子提交；已有 MeetingRecord 时，同时持有纪要发布所用的记录锁。源写入、账本注册或封存提升 revision，并取消旧 revision 的 queued/running 任务，保留已生成历史版本。
- 序号可以乱序到达；同序号、同载荷重试只返回原文一次。不同载荷、不同 ingest_id、跨场次、已封存后新增事件返回 409。遗留原文不能被新账本静默认领。
- 完整封存要求 1..final_sequence 连续、所有原文仍存在且指纹一致。中断可以封存为 incomplete；终态及最终序号不能改写。物理删除原文将 receipt 的关联置空，后续检查不再信任这份送达证明。
- 纪要快照固定送达状态；状态变化也改变输入指纹。Summary API 增加 delivery_status，历史原文快照 API 增加 delivery；继续分别检查 read_summary / read_transcript。Web 类型已同步，页面尚未切换。

## 状态含义

| 字段 | 值 | 含义 |
| --- | --- | --- |
| delivery_status | complete | 已注册运行全部封存，所声明的 FINAL 文字事件连续落库，当前原文全部纳入账本 |
| delivery_status | incomplete | 存在未收尾、中断、缺失或原文变更的运行 |
| delivery_status | unverified | 没有账本，或当前原文与账本覆盖集合不一致，例如混入旧版 Agent 写入 |
| coverage_status | unverified | 尚无整场音轨、音频结束位置及 ASR 最终完成的可信证明 |

即使 delivery_status=complete，纪要任务仍为 partial，coverage_status 仍为 unverified。页面不能把“转写器已输出的文字送达”展示成“整场音频完整识别”。多个运行全部结束也不证明 Agent 在进程启动前、重启间隙或未订阅音轨上没有漏音频。当前时间戳仍沿用 Agent 收到 FINAL 事件时的时间，不是精确媒体采样偏移。

无账本的旧快照维持原来的指纹算法和空 delivery；读取时回退 unverified，避免因字段升级使全部旧版本失效。

## Agent 收尾

1. 连接 LiveKit 后、监听参与者前，按开关注册一个运行；FINAL 事件到达时立即预留序号，再进行异步处理。
2. 翻译失败或超过 15 秒时，仍保存原文。先写入后广播翻译；HTTP 失败返回 False，成功响应必须包含合法确认 JSON，不能把 HTML 网关响应算作写入成功。重试复用相同 ingest_id / delivery_id。
3. 关闭时停止接收新的参与者，等待会话启动/关闭任务，drain 剩余会话，随后等待所有原文写入，再封存账本。修复重复连接、未知参与者断开，以及 Python 3.13 已完成 gather 不让出回调导致的收尾忙循环。
4. 收尾等待上限 45 秒；取消、异常、超时均记为 incomplete。封存请求仍有独立的 HTTP 超时与重试预算，因此 45 秒不是整个进程退出的总时限。
5. 不再在写入日志中输出逐字稿片段或服务端响应正文；保留 HTTP 状态及必要标识。

没有实现持久化 Agent outbox、断电恢复或自动补录。进程被强杀时，已注册运行会保持 open，读取为 incomplete；不根据时间流逝自动宣称完成。注册失败时明确记录日志并沿用旧写入，送达完整性保持未验证。

## 配置与验证步骤

默认关闭：后端 `MEETING_TRANSCRIPT_DELIVERY_ENABLED=false`，Agent `AGENT_TRANSCRIPT_DELIVERY_ENABLED=false`。后端还要求 `MEETING_RECORDS_ENABLED=true`；版本化纪要生成继续要求 `MEETING_VERSIONED_SUMMARY_ENABLED=true`。本批没有修改生产配置或启用真实模型调用。

测试/灰度顺序：

1. 先执行 `python manage.py migrate`，部署兼容新表的后端。
2. 启用后端两个记录/送达开关，验证准确场次已经通过现有 MeetingSession 链路建立。
3. 为测试 Agent 启用送达开关，复用现有后端 URL 和内部令牌。
4. 注册请求包含 action=begin、delivery_id（运行 UUID）、room_id、livekit_room_sid。
5. 每句请求包含 delivery_id、从 1 开始的 sequence、稳定 ingest_id 和原有原文字段。
6. 收尾请求包含 action=finish、原运行标识、final_sequence 和 outcome=complete/incomplete；遇到缺口不强行跳过或修改最终序号。
7. 用显式纪要生成命令验证快照与状态；确认仅 transport 完整时仍显示 coverage 未验证。

共享令牌是可信后端 Agent 凭证，不是终端采集授权。当前接口没有签发与参会人绑定的采集租约，也不能供 Web/Android 客户端直接调用；面向终端的独立录音鉴权另行实现。

回退时先停用 Agent 送达开关，再关闭后端新开关；保留新表与历史快照。不要反向迁移删除已形成的账本。已注册未封存运行保持未完成，不能在回退中补造完成状态。

## 验证结果

- 新增 10 项后端用例通过，包含真实 PostgreSQL 双连接并发重试、乱序/缺口、封存后写入、跨场次、载荷冲突、删除/修改原文、时区等价重试、开关/鉴权，以及生成期间送达状态变化。
- Agent 共 13 项通过（新增 9 项），使用 LiveKit Agents 1.4.5 依赖环境，网络与模型调用为 mock。覆盖尾句收尾、超时、翻译失败保留原文、重复启动、启动完成回调与退出竞态、确认响应及重试身份。
- 扩大后端回归共 99 项：88 项通过，11 项旧 Room retrieve 基线失败。已将提交 `002db528` 的 backend 单独导出到测试容器并复跑该文件，同样为 3 通过 / 11 失败：旧响应快照缺少既有字段，以及 members/administrators 查询次数预期过时。本批未改动这些接口或测试预期，不宣称全套 CI 通过。
- 专用 PostgreSQL 成功迁移至 0150，makemigrations 检查无差异，Django system check 通过。
- 新增/修改服务、接口与测试 Ruff 通过；models.py 的两处既有 DJ012 保留。Agent 检查排除原文件两处条件导入 PLC0415，其他检查通过。Web tsc -b、ESLint、Prettier 通过。
- 测试环境沿用阶段 1 专用 PostgreSQL/Redis/MinIO；Agent 使用独立容器挂载当前源码，保留镜像原有虚拟环境。不是完整锁文件 CI 重建，也没有进行真实声卡、线上队列或云模型端到端验收。

## 下一批

接入用户鉴权和幂等键保护的版本化纪要请求/重试 API，再对齐 Web 的生成、进度、历史版本与引用入口。仍待补齐独立 Speaker/采集协议、音轨与 ASR 最终完成证明、真实 Qwen 链路及 Web/Android 产品页面，阶段 1 尚未整体完成。
