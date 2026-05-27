# Sprint 2.0 字幕落表 — Follow-up 清单

Sprint 2.0（Doubao Seed-ASR + 字幕落 Transcript 表）已上线，端到端打通。
本文档汇总上线过程中识别出来的 4 个小尾巴，按优先级排列；任何一项独立
可做，不互相阻塞。

## 1. `AgentSession isn't running` 关闭时 race

**优先级**：P3（功能无影响，只是日志噪声）

**现象**：会议结束、参与者退出时，agent worker 日志出现

```
ERROR error while shutting down the job
RuntimeError: AgentSession isn't running
```

**根因**：livekit-agents 1.4.5 的关闭顺序竞态 — 参与者断开时，框架自身
已经把 `AgentSession` drain + close 过一次；随后我们的
`MultiUserTranscriber.aclose()` 又调 `sess.drain()`，第二次 drain 触发
RuntimeError。框架版本升级（1.5+）应自然消失，但本期可吞掉。

**修法**：在 [src/agents/multi_user_transcriber.py](../../src/agents/multi_user_transcriber.py)
的 `_close_session()` 中包一层 try/except：

```python
async def _close_session(self, sess: AgentSession) -> None:
    """Close and cleanup transcription session."""
    try:
        await sess.drain()
    except RuntimeError as e:
        # livekit-agents 1.4.5 races: the framework may have drained the
        # session already on participant disconnect.
        if "isn't running" not in str(e):
            raise
        logger.debug("session already drained by the framework")
    await sess.aclose()
```

**工作量**：~10 LoC，包含验证。

---

## 2. TranscriptWriter 缺少成功日志

**优先级**：P3（运维体验）

**现象**：transcript 写后端成功时无任何日志输出；调试期看 log 难判断"是
真的写进去了，还是事件根本没被回调触发"。Sprint 2.0 上线时正是因为这个，
排查 timeout / 500 / DB 是否落表多走了几步。

**根因**：[src/agents/transcript_writer.py](../../src/agents/transcript_writer.py)
中 `_post_sync()` 只在 HTTP ≥400 时 log warning，2xx 路径完全静默。

**修法**：在 `_post_sync()` 成功路径加 `logger.debug("ingested transcript len=%d speaker=%s", len(payload['text']), payload['speaker_identity'])`。生产用
DEBUG 级别即可，避免高频 INFO 刷屏；联调时改 INFO。

**工作量**：~3 LoC。

---

## 3. `speaker_name` 全为空

**优先级**：P2（影响后续 RAG / 纪要的可读性）

**现象**：DB 中 `Transcript.speaker_name` 全部为空字符串；只有 UUID 形式
的 `speaker_identity`。下游做摘要 / TODO 提取时需要"谁说了什么"，光 UUID
对人不可读。

**根因**：[src/agents/multi_user_transcriber.py](../../src/agents/multi_user_transcriber.py)
中读 `participant.name` 拿到的是 LiveKit 参与者 display name，而我们后端
签发 LiveKit token 时**没把 user 的 full_name / nickname 注入**到
`participant.name` 字段，导致它默认是空字符串。

**修法**：定位 LiveKit token 签发处（应该是
[src/backend/core/authentication/livekit.py](../../src/backend/core/authentication/livekit.py)
或 viewset 中 enter-room 处），在构造 `AccessToken` 时设置
`.with_name(user.full_name or user.email)`。

**风险**：token 内字段会被参与者列表上的所有人看到 — 确认企业内 ToB 场景
没有匿名诉求即可（we-meet 现状是 ToB，应该没问题）。

**工作量**：~10 LoC + 1 个测试。

---

## 4. 并发 ASR 连接上限

**优先级**：P2（生产规模化前必须解决）

**现象**：当前 `multi_user_transcriber` 给每个参与者起一个 `AgentSession`
+ 独立的 Doubao ASR WebSocket 连接。一个 N 人会议会同时开 N 路 ASR。
火山引擎 Seed-ASR 的 `bigmodel_async` 资源默认有并发上限（套餐通常
10–50 路），多个并发会议很快撞到。

**根因**：架构选择 — "每人一路 STT" 是 livekit-agents 推荐范式，对说话人
分离友好，但代价就是并发。

**潜在修法**（按代价由低到高）：

- **A. 监控 + 上限保护**：先在 helm `agentSubtitles.replicas` 之外加并发
  连接数指标（如 ASR ws 连接 gauge），到阈值的 80% 报警。
- **B. ASR 套餐升档**：找火山引擎升并发额度，运维侧解决，零代码改动。
- **C. 共享单 ASR 连接 + 服务器端说话人分离**：改成"一会议一 ASR"，靠
  火山的 speaker diarization 字段区分说话人。改动较大，要重写
  `MultiUserTranscriber`。
- **D. 按需启动 ASR**：参与者麦克风一直静音时不开 ASR session（基于
  `track_muted` 事件）。半成品方案。

**建议节奏**：现阶段做 A（监控），第二阶段并发真撞墙再做 B/C。不做 D。

**工作量**：A ~50 LoC（Prometheus exporter）；C ~300 LoC。

---

---

## 5. LLM 翻译"过度纠正"

**优先级**：P2（直接影响 Sprint 2.1 上线后的体验）

**现象**：上线后实测发现 LLM 会把疑似拼写错误"修正"成解释。例如：

```
原文:  "Hello word."
译文:  "There is a mistake in the original text. It should probably be 'Hello, world.'"
```

字幕场景下这种"善意修正"是 anti-feature —— 用户想要的是逐字翻译。

**根因**：[src/agents/plugins/doubao_translate.py](../../src/agents/plugins/doubao_translate.py)
中的翻译 prompt 仅说 "Translate ... Reply with ONLY the translated text"，没禁
止"纠错 / 解释 / 评论"。

**修法**：prompt 追加一句明确的禁令：

```python
prompt = (
    f"Translate the following text from {_lang_label(src or 'auto-detected')} "
    f"to {_lang_label(tgt)}. Reply with ONLY the translated text — no "
    f"explanations, no quotes, no language prefix. "
    f"Do NOT correct, comment on, or explain the input — translate it "
    f"verbatim even if it contains typos or grammatical issues.\n\n{text}"
)
```

**工作量**：~3 LoC + 1-2 句 PR 描述的真实例子。

---

## 6. Doubao STT 永远把 language 标记为 `zh`

**优先级**：P2（导致一半翻译额度被浪费）

**现象**：实测 `Transcript.language` 字段在所有行里都是 `"zh"`，包括
`"Hello, world."` 这种纯英文。

**根因**：[src/agents/plugins/doubao_pipeline/stt.py](../../src/agents/plugins/doubao_pipeline/stt.py)
中两处 ``language="zh"`` 是硬编码（L331、L415 附近），跟 STT 引擎实际识别
出的语言无关。

**直接副作用**：

- 翻译时英文输入被认为是中文 → 翻译成 `en-us` 等于自身（浪费一次 LLM 调用）
- 前端 `isSameLanguage` 判定误判（影响双语展示策略）

**修法选项**（按代价由低到高）：

- **A. LLM 自检**：在 `doubao_translate.py` 的 prompt 里加一句
  `"If the source text is already entirely in {target_lang}, reply with the original text unchanged."`
  — 最少改动，浪费的还是同样多的 token，但至少不会出错。
- **B. 翻译前做轻量语言检测**：用 `langdetect` 或简单"字符集判断"（含 CJK
  → zh、纯 ASCII 字母 → en）覆盖 STT 标签。**推荐**：~20 LoC，调用量
  减半。
- **C. 修 STT plugin**：从 Doubao ASR 响应里读真实 language。需查 Doubao
  API 是否支持，未必有；改动最大。

**推荐路径**：先 A，下次扩同传时一并做 B。

**工作量**：A ~3 LoC；B ~25 LoC。

---

## 7. 同传译文显示策略

**优先级**：P2（产品决策，不是 bug）

**现象**：Sprint 2.1 上线后，单语会议（参会者全是中文 UI、说中文）字幕**完
全看不到译文**，让人怀疑"是不是没生效"。要切到英文 UI 才能看到 demo 效
果。

**根因**：[src/frontend/src/features/subtitle/component/Subtitles.tsx](../../src/frontend/src/features/subtitle/component/Subtitles.tsx)
里的 `isSameLanguage(rowLang, uiLanguage)` 短路逻辑 —— 这是 Sprint 2.1
当时的产品判断（按需展示，不打扰）。

**三种产品定位**：

| 策略 | 触发 | 体验 |
|---|---|---|
| **A. 按需**（当前） | UI 跟原文不同语 | 不打扰；单语 demo 看不到 |
| **B. 双语对照默认开** | 所有 caption 都显示原文+译文 | 直观；屏幕占一半 |
| **C. CC 设置 toggle** ★ | 用户在 CaptionsSettings 加"显示翻译"，自己开关 | 灵活、可控、demo 友好 |

**推荐方案**：C。在 [CaptionsSettings.tsx](../../src/frontend/src/features/subtitle/component/CaptionsSettings.tsx)
加一项 "Show translation"，存到 [stores/accessibility.ts](../../src/frontend/src/stores/accessibility.ts)。
开关开了之后 `Subtitles.tsx` 跳过 `isSameLanguage` 检查；关了则维持当前
按需行为。

**工作量**：~50 LoC（UI toggle + valtio store + 持久化到 localStorage +
i18n 文案）。

---

## 处理建议（更新）

- **本 Sprint 顺手做的**：1 + 2 + **5**（共 ~18 LoC，下次改 transcriber / translate 时一并）
- **Sprint 2.3（房间侧栏 AI）前必须做**：3（RAG 要 speaker name）
- **Sprint 2 全部完成后做**：
  - 4-A（监控）；4-B/C 看真实并发情况再说
  - **6**（LLM prompt 兜底；或上轻量 langdetect）
  - **7**（CC 设置加翻译 toggle，提升 demo 与可控性）

不再单独排 Sprint —— 这些都是嵌入到下个 Sprint 自然推进的小修。
