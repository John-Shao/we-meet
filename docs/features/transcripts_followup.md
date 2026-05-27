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

## 处理建议

- **本 Sprint 顺手做的**：1 + 2（共 ~15 LoC，下次改 transcriber 时一并）
- **Sprint 2.3（房间侧栏 AI）前必须做**：3（RAG 要 speaker name）
- **Sprint 2 全部完成后做**：4-A（监控）；4-B/C 看真实并发情况再说

不再单独排 Sprint —— 这些都是嵌入到下个 Sprint 自然推进的小修。
