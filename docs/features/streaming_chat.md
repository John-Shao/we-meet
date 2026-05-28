# Sprint 2.5 — 流式输出 + 多轮对话

> 路线见 [ai_strategy.md](ai_strategy.md)；前置 Sprint 2.3 [room_ai_sidebar.md](room_ai_sidebar.md) + Sprint 2.4 [personal_ai_rag.md](personal_ai_rag.md)。这俩端点现在都是"等几秒、整段返回"的单轮模式，2.5 升级它们。

## 1. 目标

两个体验问题一并解决：

1. **打字机式流式输出** — 用户提问后 1-3s 黑屏才出文字，长答复（多场会议引用）能拖到 5s 以上。改成 SSE 流式逐 token 吐出，"正在思考…"几乎瞬间替换成第一行文字。
2. **多轮对话上下文** — 用户问"上班时间有变化吗"得到答复后接"下班呢"，目前 AI 把它当独立 RAG 查询，丢失了"我们在聊考勤"的上下文。改成把最近 N=3 轮对话传给 LLM。

## 2. 不做的事（明确边界）

- ❌ 持久化对话历史（前端 state 管理；刷新即清空。后续 Sprint 2.7+ 再考虑会话归档）
- ❌ Redis embedding cache（推迟到 Sprint 2.6 一起做 re-ranking）
- ❌ 流式答复中途取消（用户关闭抽屉就放弃；后端不主动 abort 上游 LLM 调用）
- ❌ Token usage 实时计数显示（不必要的复杂度）

## 3. 总体架构变化

### 3.1 流式（SSE）

**老链路**（仍保留兼容）：

```
POST /rooms/{id}/ask-ai/                {question}
POST /users/me/ai/ask/                  {question}
                                        → 一次性返回 {answer, ...}
```

**新增流式 endpoint**（不替换老的，前端默认走新的）：

```
POST /rooms/{id}/ask-ai-stream/         {question, history?}
POST /users/me/ai/ask-stream/           {question, history?}
                                        → text/event-stream:
                                          data: {"type":"meta","rooms_referenced":[...],"chunks_used":N,"model_used":"..."}\n\n
                                          data: {"type":"delta","text":"结论"}\n\n
                                          data: {"type":"delta","text":"是 5"}\n\n
                                          data: {"type":"delta","text":"点半"}\n\n
                                          data: {"type":"done"}\n\n
```

事件流先发 `meta`（rooms_referenced 在 LLM 调用前已知），再逐 chunk 发 `delta`，最后 `done`。错误中途用 `data: {"type":"error","message":"..."}` 再 close。

### 3.2 多轮对话

前端 `usePersonalAI` / `useRoomAI` 已经维护 `messages: [...]`，新增传递最近 N=3 轮（即 6 条消息）给后端：

```json
{
  "question": "下班呢？",
  "history": [
    {"role": "user", "content": "上班时间有变化吗？"},
    {"role": "assistant", "content": "上班时间从 8 点半改到 9 点。"}
  ]
}
```

后端拼到 OpenAI `messages` 数组里：

```python
messages = [
    {"role": "system", "content": system_prompt_with_context},
    *history,
    {"role": "user", "content": question},
]
```

**注意**：history 不影响 RAG 检索 —— RAG 仍只用最新 question 做 embedding 搜 top-K。这是有意为之：避免历史问题把搜索结果"稀释"。

## 4. 后端实现

### 4.1 LLMClient 扩展（~30 LoC）

```python
class LLMClient:
    # 新增方法（不动现有 chat()）
    def chat_stream(
        self, *, messages: list[dict], temperature: float = 0.3,
        max_tokens: int = 1200,
    ) -> Iterator[str]:
        """Yield text chunks as the model streams. Caller assembles
        the full answer if it needs to."""
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )
        for ev in resp:
            delta = ev.choices[0].delta.content or ""
            if delta:
                yield delta
```

### 4.2 Service 层：增加 stream 入口

`RoomAIService` / `PersonalAIService` 各新增 `ask_stream(...)` 方法返回一个 generator：

```python
def ask_stream(self, *, user/room, question, history) -> Iterator[dict]:
    # ... 同 ask() 的 RAG 检索逻辑 ...
    yield {"type": "meta", "rooms_referenced": [...], "chunks_used": N, "model_used": ...}
    messages = [{"role":"system","content":system}, *history, {"role":"user","content":question}]
    for delta in llm.chat_stream(messages=messages):
        yield {"type": "delta", "text": delta}
    yield {"type": "done"}
```

通用 RAG / context 构造代码与 `ask()` 共享（抽出 `_build_context` 私有方法），避免分裂。

### 4.3 View 层：StreamingHttpResponse（~40 LoC × 2）

DRF 不擅长 SSE，直接用 Django 的 `StreamingHttpResponse`，bypass DRF renderer：

```python
@action(detail=True, methods=["post"], url_path="ask-ai-stream", ...)
def ask_ai_stream(self, request, pk=None):
    room = self.get_object()
    serializer = AskAIStreamSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    question = serializer.validated_data["question"]
    history = serializer.validated_data.get("history") or []

    def gen():
        try:
            for ev in RoomAIService().ask_stream(
                room=room, question=question, history=history
            ):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f'data: {json.dumps({"type":"error","message":str(exc)})}\n\n'

    resp = StreamingHttpResponse(gen(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"   # nginx 不要 buffer
    return resp
```

`X-Accel-Buffering: no` 关键，否则 nginx 把流式 buffer 成整段。

### 4.4 Serializer

`AskAIStreamSerializer` / `AskPersonalAIStreamSerializer`：在原 serializer 基础上加 `history` 字段（≤6 条，每条 ≤2000 字符）。

### 4.5 限频

复用现有的 `RoomAIRateThrottle` / `PersonalAIRateThrottle`，scope 名不变。一次 SSE 连接计 1 次。

## 5. 前端实现

### 5.1 SSE 消费工具（~80 LoC）

新建 `src/frontend/src/api/sseStream.ts`：

```typescript
export async function* sseStream(url, init) {
  const resp = await fetch(url, init)
  if (!resp.ok) throw new ApiError(resp.status, await resp.text())
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    // SSE 帧分隔: 两个换行
    while (true) {
      const idx = buf.indexOf('\n\n')
      if (idx < 0) break
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (frame.startsWith('data: ')) {
        yield JSON.parse(frame.slice(6))
      }
    }
  }
}
```

### 5.2 改造 useRoomAI / usePersonalAI（~60 LoC × 2）

把 `useMutation(askXxxAI)` 换成手写的 `ask()` 函数：发起 fetch → 逐 event 更新当前 assistant 消息的 `content` 字段：

```typescript
const ask = useCallback(async (question: string) => {
  const userMsg = { id: nextId(), role: 'user', content: question, ... }
  const asstId = nextId()
  setMessages(prev => [...prev, userMsg, {id: asstId, role: 'assistant', content: '', ...}])
  setIsAsking(true)
  try {
    // 多轮：发最近 6 条消息（不含本轮 user）
    const history = messages.slice(-6).map(m => ({role: m.role, content: m.content}))
    for await (const ev of sseStream(url, { method: 'POST', body: JSON.stringify({question, history}) })) {
      if (ev.type === 'meta') {
        setMessages(prev => prev.map(m => m.id === asstId ? {...m, roomsReferenced: ev.rooms_referenced} : m))
      } else if (ev.type === 'delta') {
        setMessages(prev => prev.map(m => m.id === asstId ? {...m, content: m.content + ev.text} : m))
      } else if (ev.type === 'error') {
        throw new Error(ev.message)
      }
    }
  } catch (e) { setError(e) } finally { setIsAsking(false) }
}, [messages])
```

### 5.3 UI 极小改动

打字机效果"免费"得到（content 边增长边渲染）。需要的微调：

- 流式过程中 assistant 气泡末尾加一个闪烁光标
- markdown 渲染对未完成的 markdown 容错（react-markdown 9 已经做得很好）

## 6. 关键决策

| 抉择 | 选择 | 理由 |
|---|---|---|
| 协议 | **SSE (POST + text/event-stream)** | WebSocket 重，HTTP/2 推送不普及；POST 携带 body 而 EventSource 只能 GET，自己 fetch 读流 |
| 新端点 vs 改老的 | **新端点 `ask-ai-stream`** | 老端点保留兼容（手机 App 后续走非流式）；service 层共享 |
| history 持久化 | **前端 state，不入库** | UX 简单；刷新即清空可接受 |
| history 上限 | **最近 6 条（3 轮）** | Doubao Pro 32K context 够用；防止上下文爆炸 |
| RAG 检索是否用 history | **不用**，只用本轮 question 做 embedding | 避免历史问稀释当前问的检索精度 |
| 中途取消 | **不实现**，连接断了让 LLM 调用自然完成 | Doubao 无法中途中断，强行 abort 也不省钱 |
| nginx 配置 | 加 `X-Accel-Buffering: no` 头 + nginx ingress `proxy_buffering off` 双保险 | SSE 经典坑 |

## 7. 风险与缓解

1. **nginx ingress buffer 流** — 默认会把 chunked response 缓冲，导致前端等到整段才收到。解决：上线前在 ingress annotation 加 `nginx.ingress.kubernetes.io/proxy-buffering: "off"`。
2. **Doubao stream 偶发卡顿** — 单次 chunk 间隔可能突然 2-3s。前端"思考中"光标 + 不显示具体 token/s 数字，避免暴露。
3. **history 注入历史 prompt 越狱** — assistant 消息是后端历史回复，是可信的；user 消息是真实用户输入。但 user 历史可能包含越狱 prompt。缓解：history 只来自前端的当前会话状态（即用户自己生成的），不会跨用户传染；后端 system_prompt 始终最先。
4. **流断开后状态不一致** — 网络中断时 assistant 气泡卡在半截。缓解：finally 里把 isAsking 复位；前端显示"中断，重试？"按钮。

## 8. 落地节奏

| Step | 内容 | 预计 |
|---|---|---|
| 1 | LLMClient.chat_stream + 单测 | 1h |
| 2 | RoomAIService / PersonalAIService.ask_stream + 单测 | 2h |
| 3 | 两个新 endpoint + serializer + nginx 头 | 2h |
| 4 | 前端 sseStream 工具 + 改造两个 hook | 3h |
| 5 | UI 微调（光标 + 中断按钮）+ i18n | 1h |
| 6 | nginx ingress annotation + 部署 + 端到端冒烟 | 1h |

**合计 ~10h**，建议拆 2 PR：

- PR1 = Step 1-3（后端）
- PR2 = Step 4-6（前端 + 部署）

## 9. 验证清单

1. 浏览器 F12 → Network → `/ask-ai-stream/` 显示 `EventStream` 标签 + 实时帧
2. 提问"我最近的会议讲了什么" → 字符**逐渐**出现，不是一次性
3. 接着问"具体是哪一场" → 答复中**回看到第一个问题的上下文**
4. 4G 切到飞行模式 → 气泡显示中断状态，可重试
5. 第 11 次提问 → 429 限频（旧行为保留）
6. 老 `/ask-ai/`（非流式）依然返回完整 JSON（向后兼容）

---

**Sprint 2.6 路标**：在 2.5 流式 + 多轮基础上，加 Redis cache（embedding hit-rate 提升）+ re-ranking + 混合检索（BM25 + vector）。
