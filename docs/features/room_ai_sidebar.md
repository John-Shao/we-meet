# Sprint 2.3 — 房间侧栏 AI（基于当前会议字幕的 QA）

> 本文档是 Sprint 2.3 的设计与落地方案。AI 总体策略见 [ai_strategy.md](ai_strategy.md)；
> 字幕基础设施见 [subtitles.md](subtitles.md) / [transcription.md](transcription.md)；
> 会议纪要见 [summarization.md](summarization.md)。

---

## 1. 目标

会议进行中，用户在房间右侧打开 AI 面板，用文字问任意问题：

- "刚才张三说啥？"
- "最近 5 分钟的要点"
- "我们对 XX 议题达成共识了吗？"

AI 基于**当前会议已落表的 transcripts** 用中文回答。

## 2. 不做的事（明确边界）

- ❌ 语音输入/输出（那是 Sprint 1 在 App 端做的事，见 [ai_assistant.md](ai_assistant.md)）
- ❌ 跨会议检索（那是后续 Sprint 2.4 的"我所有会议的 AI"）
- ❌ 会话历史持久化（MVP 前端 state 即可，刷新就清空）
- ❌ 流式输出（MVP 一次性 return；后续可升 SSE）
- ❌ Embedding / Vector DB（MVP 直接整段 transcript 塞 prompt，超长截最近的）
- ❌ 会议结束后在详情页继续问（MVP 仅房间内可用；结束后只展示 Summary/ActionItems）

## 3. 总体架构

```
[前端] LiveKit Room
   ControlBar
     └─ RoomAIToggle (新按钮)
          └─ RoomAISidebar (右侧抽屉)
               ├─ 消息列表 (user / assistant 气泡)
               └─ 输入框 → POST /api/v1.0/rooms/{id}/ask-ai/

[后端]  RoomViewSet.ask_ai
   ├─ 鉴权: requester 必须是房间参与者 (复用 livekit token 解析)
   ├─ 取 transcripts(room, 最近 N 条 / 总量 ≤ 60K bytes)
   └─ RoomAIService.ask(room, question, requester)
        ├─ 构造 context = "[hh:mm:ss] 张三: ...\n[hh:mm:ss] 李四: ..."
        ├─ system_prompt: "你只能基于上面的会议记录回答；找不到就说没记录到"
        └─ LLMClient.chat(system, user=question) → answer
```

## 4. 接口设计

### POST `/api/v1.0/rooms/{room_id}/ask-ai/`

**Request**

```json
{ "question": "刚才关于下班时间的讨论结论是什么？" }
```

**Response (200)**

```json
{
  "answer": "结论是把下班时间从 6 点改到 5 点半。\n相关发言：\n- John（17:50）：吃好饭的关键是按时吃\n- WeMeet（17:51）：建议把下班时间改到 5 点半",
  "transcripts_used": 8,
  "model_used": "doubao-seed-1-6"
}
```

**错误码**

| Code | 含义 |
|---|---|
| 400 | question 为空 / 超长（>500 字符） |
| 403 | 非房间参与者 |
| 404 | 房间不存在 |
| 429 | 触发限频（单用户 10 req/min） |
| 503 | LLM 调用失败 / timeout |

## 5. 后端实现（约 130 LoC）

### 5.1 新增 `src/backend/core/services/room_ai.py`（~90 LoC）

```python
class RoomAIService:
    MAX_CONTEXT_BYTES = 60_000   # 与 MeetingSummaryService 一致

    @classmethod
    def ask(cls, *, room, question, requester_display) -> dict:
        transcripts = cls._collect_recent(room)
        context = cls._format(transcripts)
        system = cls._build_system_prompt(room, context)
        answer = LLMClient.from_settings().chat(
            system=system, user=question, temperature=0.3
        )
        return {
            "answer": answer,
            "transcripts_used": len(transcripts),
            "model_used": settings.DOUBAO_LLM_ENDPOINT,
        }

    @staticmethod
    def _collect_recent(room):
        """倒序取，累积到 MAX_CONTEXT_BYTES 为止，最后再升序返回。"""
        rows = (Transcript.objects.filter(room=room)
                .order_by("-started_at").iterator())
        picked, total = [], 0
        for r in rows:
            size = len(r.text.encode("utf-8")) + 40   # +时间戳/speaker 元数据
            if total + size > RoomAIService.MAX_CONTEXT_BYTES:
                break
            picked.append(r)
            total += size
        return list(reversed(picked))
```

### 5.2 修改 `src/backend/core/api/viewsets.py` 新增 1 个 action（~25 LoC）

```python
@action(detail=True, methods=["post"], url_path="ask-ai")
def ask_ai(self, request, pk=None):
    room = self.get_object()
    requester = _resolve_room_participant(request, room)
    if not requester:
        return Response({"detail": "not a participant"}, status=403)
    question = (request.data.get("question") or "").strip()
    if not question:
        return Response({"detail": "question required"}, status=400)
    if len(question) > 500:
        return Response({"detail": "question too long"}, status=400)
    try:
        result = RoomAIService.ask(
            room=room,
            question=question,
            requester_display=requester.get("name") or "用户",
        )
    except Exception as e:
        logger.exception("room ai failed")
        return Response({"detail": str(e)}, status=503)
    return Response(result)
```

### 5.3 新增 `AskAISerializer`（~10 LoC）

仅做 question 长度与非空校验。

## 6. 前端实现（约 280 LoC）

新增目录 `src/frontend/src/features/room-ai/`：

| 文件 | LoC | 职责 |
|---|---|---|
| `api/askRoomAI.ts` | ~20 | fetch wrapper |
| `hooks/useRoomAI.ts` | ~50 | useMutation 包装 + 本地消息列表 state |
| `components/RoomAIToggle.tsx` | ~30 | ControlBar 按钮 |
| `components/RoomAISidebar.tsx` | ~180 | 右侧抽屉：消息列表 + 输入框 |

**RoomAISidebar 细节**：
- 消息列表展示 user / assistant 气泡 + 时间戳
- 输入框：Enter 发送、Shift+Enter 换行
- assistant 消息用 `react-markdown` 渲染（已有依赖，Sprint 2.2 引入）
- loading 状态 + 错误 toast

**修改**：
- [src/frontend/src/features/rooms/livekit/prefabs/ControlBar/ControlBar.tsx](../../src/frontend/src/features/rooms/livekit/prefabs/ControlBar/ControlBar.tsx) — 与 chat 同级位置插入 `<RoomAIToggle />`
- `locales/{zh,en,fr,de,nl}/room-ai.json` — 按钮文案 / placeholder / 错误信息

## 7. 关键决策

| 抉择 | MVP 选择 | 理由 / 后续升级 |
|---|---|---|
| context 注入方式 | 全部 transcripts 塞 prompt | 60K bytes ≈ 30K 中文字符 ≈ 4h 会议；超了截最近的。Sprint 2.4 再考虑 embedding |
| 多语种 | 只塞原文不塞翻译 | 省 token；Doubao 本身能跨语种理解 |
| 历史会话 | 不持久化、单轮 | 大部分用例是"一问一答"；省 DB schema 改动 |
| 流式输出 | 一次性 return | 30 字回答 LLM 端 ~2-3s 就够，可接受 |
| 鉴权 | 必须是房间参与者 | 复用 livekit token；非参与者拒绝 |
| 限频 | 单用户 10 req/min | DRF throttle，防滥用 |
| 会议结束后 | 不开放 ask | 详情页只展示 Summary/ActionItems |

## 8. 风险与缓解

1. **transcripts 实时性** — agent FINAL-only 落库有 1–2 s 延迟，用户问"刚才说啥"可能漏最后一句。MVP 接受，前端文案说明"基于已落表的字幕"。
2. **超长会议** — 截最近的 N 条，前端文案提示"基于最近 4 小时的发言"。
3. **Prompt 注入** — question 严格放到 user role，不拼进 system prompt；system prompt 写死指令边界。
4. **LLM 调用慢 / 失败** — 60 s timeout（复用 LLMClient 默认）；失败返回 503 + 友好 toast。
5. **隐私** — 房间结束后用户不能再 ask（前端入口在 ControlBar，房间销毁即不可达）。

## 9. 落地节奏

| 步骤 | 内容 | LoC |
|---|---|---|
| **Step 1** | RoomAIService + ask_ai endpoint + 单测 | ~150 |
| **Step 2** | 前端 hook + Sidebar + Toggle | ~280 |
| **Step 3** | i18n 5 语言 + ControlBar 接入 | ~50 |
| **Step 4** | 部署 + 端到端冒烟（开会 → 边开边问 → 验证答复引用最近发言） | — |

**合计约 480 LoC，1 PR。**

## 10. 验证要点（部署后）

1. 开一场会议，说几句话（等字幕落表，每条 final 1–2 s 延迟）
2. 在 ControlBar 看到 AI 按钮，点开侧栏
3. 问"刚才说了什么"，AI 答复引用具体发言 + 时间
4. F12 Network 验证 `POST /rooms/{id}/ask-ai/` 200 OK
5. 关掉房间再开一个，用同 token 直接 `curl` 调老房间的 endpoint → 403
6. 触发 11 次以上请求 → 第 11 次 429

---

**下游 Sprint**：
- **Sprint 2.4**：跨会议 AI（我所有会议的 RAG，引入 embedding + pgvector）
- **Sprint 2.5**：流式输出（SSE）+ 会话上下文（多轮对话）
