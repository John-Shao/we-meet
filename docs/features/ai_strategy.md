# AI 落地策略

> 这是 we-meet AI 能力的总体方案。`ai_assistant.md` 是早期单一文档化的初版 omni 集成方案，本文档取代它作为后续执行依据；omni 实现本身保留，但承担的角色已重新定位（详见 §4）。

---

## 1. 背景与产品判断

### 1.1 通用 AI 助手赛道无胜算
豆包 App、通义 App、Kimi、ChatGPT 已占据用户心智。we-meet 单做一个通用对话助手进入这个市场，无差异化、无胜算。

### 1.2 会议场景 AI 的核心错位
把 ChatGPT 范式（实时双工对话）直接塞进多人会议，会踩四个假设漏洞：
1. 假设只有一个说话者 → 多人 turn-detection 崩
2. 假设 AI 回复值得所有人听 → 99% 时候只该给召唤者
3. 假设上下文短 → 3 小时会议 transcript 塞不进 omni session
4. 假设 AI 是参与者 → 多数会议需要它当工具/速记员，不当嘉宾

**多数会议价值在"信息层"，不在"音轨层"。AI 该说话的场景比想象中少得多。**

### 1.3 真正护城河
we-meet 是 ToB 产品，企业内部使用，数据归属企业。这意味着：
- AI 能力的差异化**不在模型**（公有云大模型已经够强）
- 差异化在**有用户的会议数据**（transcript / 决策 / TODO / 参与者关系图）

通用 AI 助手做不到"上周三那个项目复盘会，张总最关心的指标是什么？"。**we-meet 能。**

### 1.4 落地总原则
- **低侵入、高价值** 优先（字幕 / 同传 / 纪要 / TODO）
- **多模态 omni** 用对场景才有意义：1v1 场景（生活助手 App）放开；多人会议场景克制
- **复用克制** 比"加新功能"重要：能用普通 REST + LLM 解决的，不要塞 omni / agent worker / WebSocket

---

## 2. 三个 AI 角色 × 两个端

| AI 角色 | 输入 | 输出 | 数据范围 | Web 端 | 安卓 App |
|---|---|---|---|---|---|
| **房间侧栏 AI** （会议中） | 文字 + Seed-ASR | 文字 + 可选本地 TTS | 本次会议 transcript | ✅ | ✅ |
| **房间外 AI** （会议外） | 文字 + Seed-ASR | 文字 + 可选本地 TTS | 我参与的**所有**会议 | ✅ | ✅ |
| **通用 AI 助手** （生活） | 文字 + omni 实时音视频 | 实时音 + 字幕 | 无会议数据 | ❌ | ✅ |

**端对等约定**：移动端 App = Web 端能力 + 通用 AI 助手。Web 端有的，Android 都要有；通用 AI 助手仅 App 端有。

---

## 3. 数据底座

### 3.1 已有（无需改动）
- `AIVendor` / `AIModel` / `AIAgentProfile` / `AIVoice` / `AIPrompt`
- LiveKit Room + agent worker 框架（`agents/ai_assistant.py` + plugins）

### 3.2 新增（Sprint 2 一并建好）
| 模型 | 用途 |
|---|---|
| `Transcript` | 字幕落表（meeting_id + start_ts + speaker_identity + text + lang） |
| `Summary` | 会议摘要（meeting_id + content + generated_at），1:1 |
| `ActionItem` | TODO 抽取（meeting_id + owner + content + deadline + source_transcript_id） |
| `TranscriptEmbedding` | pgvector 索引（meeting_id + transcript_id + vector），用于 RAG |
| `SummaryEmbedding` | pgvector 索引 |

### 3.3 ACL 模型
所有 RAG 查询的范围 = `Meeting.participants 包含 current_user 的所有 meeting`。在 Django ORM 层 join 过滤一次，pgvector 子集查询。**不引入额外的 RBAC 框架。**

ToB 单租户假设：当前 we-meet 部署 = 一个企业。未来如要支持多租户，再加 `Organization` FK，本期不动。

### 3.4 向量库选型：pgvector
- we-meet 已有 PostgreSQL，0 新组件
- 备份 / 监控 / ACL 全部沿用 Django ORM 体系
- 容量上限：单企业 ToB 几万会议、千万条字幕级别完全够用
- 数据量真到 Milvus / Qdrant 级别再迁

---

## 4. 现有 omni 代码的处置

Sprint 1（已上线）做的 omni 实现没有浪费，但**承担的角色变了**：

| 资产 | 旧定位 | 新定位 |
|---|---|---|
| `agents/ai_assistant.py` + 三个 plugin | 会议工具栏召唤 AI 参与者 | **专供安卓端通用 AI 助手**（1v1 房间，房间名 `ai-private-{user_id}-{uuid}`） |
| 前端 `features/ai-assistant/AIAssistantToggle` | 会议工具栏入口 | **Web 端撤回**（隐藏 toggle 或删除），Sprint 3 安卓端复用 omni 协议但不复用 Web UI |
| `agentAIAssistant` helm deployment | 会议端 dispatch 目标 | Sprint 3 之前 `replicas: 0`，Sprint 3 启用为安卓端服务 |
| AIVendor/Model/Profile/Voice/Prompt schema | 会议端 catalog | **不动**，两个 AI 角色都共用 |

---

## 5. Sprint 拆解

按依赖顺序排，Sprint 2 全部完成后再进 Sprint 3。

### Sprint 2.0 — 字幕基础设施（前置）

**目标**：会议字幕落表 + 默认开启。

- 改造 `agents/multi_user_transcriber.py`：加 `STT_PROVIDER=doubao` 分支，复用 `agents/plugins/doubao_pipeline/stt.py` 中的 `DoubaoSTT`
- 字幕流写一份到 `Transcript` 表（Django ORM + post-write hook）
- helm `agentSubtitles`：`replicas: 1`，env 切换 `STT_PROVIDER=doubao`
- 前端：会议中字幕已有展示，无需改

**验收**：开会时所有人说话都写入 `Transcript` 表，前端实时字幕正常。

### Sprint 2.1 — 同传字幕

**目标**：多语言会议刚需。

- 在 transcribe agent 内或单独 agent，把字幕流过 LLM 翻译（Doubao Pro / Qwen），按用户偏好语言生成译文
- 译文走 LiveKit DataChannel 推送（不是字幕原文流）
- 前端：每个参与者按自己语言偏好显示 `原文 / 译文` 双行（可折叠）
- 用户偏好语言：复用 Django `User.language` 或新增 `User.subtitle_lang`

**验收**：中英双语会议，中文用户看到英文发言译成中文，反之亦然。

### Sprint 2.2 — 纪要 + TODO 自动归档 + 可检索

**目标**：会议结束自动产出结构化产物，写入向量库。

- 复用现有 `meet-summary` 服务，扩展产物：
  - 写 `Summary` 表（一次会议一条）
  - 抽 `ActionItem` 表（LLM 抽取 owner / content / deadline，关联原句 transcript）
- 都生成 embedding，写入 `SummaryEmbedding` / `TranscriptEmbedding`
- 前端：会议详情页展示 Summary + ActionItem 列表，可勾选完成（不在本期做协同，仅展示）

**验收**：开完会 1 分钟内能在详情页看到摘要 + 行动项；vector 索引可查询到。

### Sprint 2.3 — 房间侧栏 AI（会议中查询）

**目标**：参与者在会议进行中私聊 AI，不打扰其他人。

**后端**
- `core/services/meeting_qa.py`：输入 `(meeting_id, user_id, question)`，RAG 检索范围限定本会议的 Transcript + Summary + ActionItem
- API：`POST /api/v1.0/meetings/{id}/ask`，SSE 流式返回 LLM 回复
- 鉴权：current_user 必须是 `meeting.participants` 成员

**Web 前端**
- 会议中右侧栏新增 "AI 助手" 标签页（与 Chat / Participants 并列）
- 输入框 + 麦克风按钮（按住录音 → 一次性调 Doubao Seed-ASR → 转文字提交）
- 回复区流式渲染文字；每条回复底部一个「朗读」按钮（用浏览器 `SpeechSynthesis` 本地播放，不进会议音轨）

**安卓前端**
- 在 `ui/room/RoomScreen.kt` 工具栏加一个 "AI 助手" 按钮，弹出 `AIAssistantPanel.kt`（Compose 模态底片或侧抽屉）
- 复用现有 `MessagesPanel.kt` 的 UI 模式（基于 LiveKit data channel 的聊天 UI）但走 REST + SSE，而不是 data channel
- 麦克风录音用 Android `MediaRecorder`，上传到后端走 Seed-ASR

**验收**：会议进行中提问"刚才张总说的销售目标是多少？"，AI 在 2-5 秒内文字回答，引用具体某句字幕作为来源。

### Sprint 2.4 — 房间外 AI（跨会议）

**目标**：会议结束后 / 跨会议查询。

- 后端：复用 `meeting_qa`，扩 ACL 模式 `scope="all_my_meetings"`，检索范围 = `current_user 参与的所有 meeting` 的 transcript + summary + action_items
- API：`POST /api/v1.0/ai/ask`（不绑 meeting_id），同样 SSE 流式
- Web 前端：dashboard / 会议历史页加入口（独立路由 `/ai` 或顶部 search-like 入口）
- 安卓前端：底部 tab 加 "AI 助手"，进入 Chat-like 页面

**验收**：用户问"我上周三的项目复盘会，决议是什么？"，AI 跨会议检索后回答，附原会议链接。

### Sprint 3 — 通用 AI 助手（仅 App）

**目标**：安卓端独立的生活助手，omni 实时音视频，与会议数据完全隔离。

**后端**
- 新增 API：`POST /api/v1.0/personal-assistant/start`，签 LiveKit token + dispatch agent
- 不绑定 `Room` model，房间名规则 `ai-private-{user_id}-{uuid}`
- agent worker 复用 `agents/ai_assistant.py`，profile 用 `qwen` / `doubao_s2s` 之一

**安卓前端**
- 底部 tab 加 "通用助手"
- 默认是文字 chat（不调 omni）
- "语音通话" 按钮 → 调 `/personal-assistant/start` 拿 token → LiveKit SDK 加入房间 → omni 实时对话
- 通话结束 → leave room，后端房间销毁

**Web 端不做**（默认隐藏入口）。

---

## 6. 工程技术决策

| 项 | 决策 | 理由 |
|---|---|---|
| 向量库 | **pgvector** | 零新组件，复用 Django ORM / ACL / 备份 |
| ASR | **Doubao Seed-ASR**（已在 `plugins/doubao_pipeline/stt.py` 实现） | 中文准确率高、已经接好、企业内服务 |
| LLM 推理 | Doubao Pro（生成）/ Doubao Embedding（向量） | 与现有 ARK_API_KEY 复用 |
| RAG 框架 | **不引 LangChain / LlamaIndex** | ~200 LoC 手写 SQL + LLM call 足够；避免锁定 |
| 流式输出 | **SSE**（Server-Sent Events） | 比 WebSocket 简单；安卓和 Web 都易消费 |
| ACL | Django ORM filter join `MeetingParticipant` | 单租户 ToB，简单可靠 |
| Web TTS | 浏览器 `SpeechSynthesis` | 不走 LiveKit 音轨、不打扰会议、零成本 |
| Android TTS | Android 系统 `TextToSpeech` | 同上 |

---

## 7. Web / Android 端对等矩阵

基于安卓现状（Kotlin + Compose + LiveKit 2.23.5 + 短信 OTP + Retrofit）：

| 能力 | Web 现状 | Android 现状 | Sprint |
|---|---|---|---|
| 视频会议本体 | ✅ | ✅ | 已完成 |
| 字幕显示 | ✅（multi_user_transcriber 已有，但 replicas=0） | ❌ | 2.0 + Android 端补 |
| 同传双语字幕 | ❌ | ❌ | 2.1 |
| 会议详情页 Summary + TODO | ❌ | 部分（History 已有） | 2.2 |
| 房间侧栏 AI | ❌ | ❌ | 2.3 |
| 房间外 AI | ❌ | ❌ | 2.4 |
| 通用 AI 助手 | ❌（不做） | ❌ | 3 |

**安卓端工作量预估**（基于探索报告）：
- 字幕显示 UI：低（~80 LoC，Compose 文本叠加层）
- 房间侧栏 AI：中低（~200 LoC，复用 MessagesPanel 模式 + 麦克风录音）
- 房间外 AI：中（~250 LoC，新 tab + chat UI + SSE 消费）
- 通用 AI 助手：中（~400 LoC，复用 LiveKitController + 新 UI）

---

## 8. 关键风险与开放问题

| 风险 | 缓解 |
|---|---|
| 单会议 transcript 超长（3 小时 × 多人），LLM 上下文塞不下 | RAG 检索 top-K（默认 K=20），不全量喂；超长会议自动滚动摘要 |
| 同传翻译质量参差 | Sprint 2.1 仅支持 2-3 种语种（中英日），按需扩 |
| 跨会议 ACL 漏洞（让用户看到他没参加的会议） | 一律 Django ORM filter `participants__in=[user]`，禁止任何旁路 |
| omni 模型成本（按音频分钟计费） | 通用助手 App 加并发上限 + 单次通话 ≤30min；超时自动结束 |
| pgvector 性能上限 | 监控 query latency，>500ms 触发预警；真到上限再迁 |
| 安卓 / Web RAG 体验差异 | 后端 SSE 协议统一，前端只负责消费；不允许任何一边私自加字段 |

### 开放问题（暂不决定）
- TODO 自动归档后是否做"@张三 提醒"等协同（暂不做，可能引入 IM 边界）
- 会议结束后多久删除原始字幕（合规需求出来再定，默认保留）
- 是否允许会议主持人关闭某次会议的 RAG 索引（合规需求）

---

## 9. 落地节奏

```
今天 → Sprint 2.0 (字幕基础) → 2.1 (同传) → 2.2 (纪要/TODO) → 2.3 (房间内 AI) → 2.4 (房间外 AI) → Sprint 3 (通用助手)
        前置依赖                                                     ↑                       ↑
                                                       会议中 demo 卖点         跨会议 demo 卖点
```

每个 Sprint **同时推进 Web 与安卓**（除 Sprint 3 仅安卓）。后端 API 一次开发两端复用。

---

## 10. 不做的事（明确拒绝）

防止后续讨论中重新被提起：

- ❌ AI 当会议主持 / 协调员（侵入性过高）
- ❌ AI 主动发言提醒"你们偏题了"（anti-feature）
- ❌ 给 AI 注入 `function_tool` 控制会议（静音参与者等）（权限边界混乱）
- ❌ Web 端的通用 AI 助手（与豆包/通义直接竞争，无胜算）
- ❌ 在会议工具栏继续保留 omni 召唤入口（违反"低侵入"原则）
- ❌ 引入 LangChain / LlamaIndex / 单独向量数据库（过度工程）
