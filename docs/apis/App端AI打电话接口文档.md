# App 端 AI 打电话 — 接口文档

> Android 客户端 `feature-assistant` 模块（AI Call / 打电话）与 we-meet 后端的接口契约。
> 模块代码：[`feature-assistant/.../aicall`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/)
> 字段或行为变更时，请同步更新本文档、后端 viewset 与 Android DTO（`AiCallDtos.kt`）。

---

## 1. 通用约定

| 项 | 值 |
|---|---|
| Base URL（生产） | `https://meet.we-meet.online` |
| 默认鉴权 | `Authorization: Bearer <OIDC access_token>` |
| LiveKit 鉴权 | `Authorization: Bearer <LiveKit room token>` —— 只用于 `start-ai-agent` / `stop-ai-agent`（详见 §3） |
| 请求/响应体 | JSON（`Content-Type: application/json`） |
| 时间格式 | ISO 8601，如 `2026-06-05T14:58:12.345Z` |
| 错误响应 | 业务错误 `{"error": "<msg>"}`；DRF 默认 `{"detail": ...}` 或字段级错误字典 |

---

## 2. 端到端时序

```
App                                                  Backend                            LiveKit
 │  ① POST /api/v1.0/rooms/                            │
 │  (OIDC bearer; {name, access_level:"public"})       │
 │ ───────────────────────────────────────────────▶  ──┤
 │  201 {id, slug, livekit:{url, room, token}}         │
 │ ◀─────────────────────────────────────────────── ──┤
 │                                                     │
 │  ② GET /api/v1.0/rooms/ai-agent-config/             │
 │  (OIDC bearer 可选)                                  │
 │ ───────────────────────────────────────────────▶  ──┤
 │  200 {profiles, prompts, user_preference}            │
 │ ◀─────────────────────────────────────────────── ──┤
 │                                                     │
 │  ③ LiveKit connect(url, token)                                                       ───▶
 │  ◀────────────────────────────── (Participant joined)                                ──┤
 │                                                     │
 │  ④ POST /api/v1.0/rooms/{id}/start-ai-agent/        │
 │  (LiveKit Bearer + No-Auth; {profile_code, voice_id, prompt_id})                     │
 │ ───────────────────────────────────────────────▶  ──┤
 │  200 {status:"success", profile_code, voice_id, prompt_id}                            │
 │ ◀─────────────────────────────────────────────── ──┤
 │                                                     │  ai-agent worker 加入房间       │
 │  ◀──────────────────────────── RoomEvent.ParticipantConnected(identity="ai-agent…")  ──┤
 │                                                     │
 │  …通话进行中：双方音/视频流走 LiveKit。语音模式由后端 omni 模型实时转写+回复…           │
 │                                                     │
 │  ⑤ 用户挂断：                                       │
 │  POST /api/v1.0/rooms/{id}/stop-ai-agent/           │
 │  (LiveKit Bearer + No-Auth)                          │
 │ ───────────────────────────────────────────────▶  ──┤
 │  200 {status:"success"}                              │
 │ ◀─────────────────────────────────────────────── ──┤
 │                                                     │
 │  ⑥ POST /api/v1.0/rooms/{id}/end/                   │
 │  (OIDC bearer)                                      │
 │ ───────────────────────────────────────────────▶  ──┤
 │  200 {status:"success", ended_at}                    │
 │ ◀─────────────────────────────────────────────── ──┤
 │                                                     │
 │  ⑦ LiveKit disconnect()                                                              ───▶
```

App 侧实现入口：[`AiCallViewModel.runConnectFlow`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/vm/AiCallViewModel.kt)。

---

## 3. 鉴权约定（重点）

App 端默认的 `AuthInterceptor` 会给每个请求注入 OIDC Bearer。**`start-ai-agent` / `stop-ai-agent` 不能用 OIDC**——后端这两条 endpoint 强制 `LiveKitTokenAuthentication`，OIDC token 会被解析失败，返回 401。

解决方式（见 [`AiAgentApi.kt`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/data/AiAgentApi.kt)）：

1. Retrofit 接口显式设置 `@Header("Authorization") authorization: String`，传 `Bearer <livekit_token>`；
2. 同时挂上 `@Header("No-Auth") "1"`——`AuthInterceptor` 见到该标记会**跳过**自动注入，让自定义 Authorization 头透传到后端；
3. `livekit_token` 取自 ① 中房间创建响应的 `livekit.token`。

> 历史坑：早期忘了 `No-Auth`，OIDC bearer 覆盖了 LiveKit token → 401。详见 memory `reference-livekit-auth-chain`。

---

## 4. 接口详解

### 4.1 创建房间（AI 会话）

`POST /api/v1.0/rooms/`

**鉴权**：OIDC Bearer。

**请求体**：

```json
{
  "name": "__JUSI_AI_SESSION__-1717603200000",
  "access_level": "public"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 房间显示名。App 端用前缀 `__JUSI_AI_SESSION__-` + 创建时戳，便于服务端审计区分纯 AI 会话 |
| `access_level` | string | 否 | `public` / `trusted` / `restricted`。AI 通话走 `public`，房间隐式只有用户 + AI worker |
| `configuration` | object | 否 | 房间能力配置（参考 `RoomConfiguration` 模型）。AI 打电话当前不传 |
| `pin_code` | string | 否 | 加入口令；AI 会话无需 |

**201 Created**（成功）：

```json
{
  "id": "1a2b3c4d-...-uuid",
  "name": "__JUSI_AI_SESSION__-...",
  "slug": "12345678",
  "configuration": {},
  "access_level": "public",
  "pin_code": null,
  "created_at": "2026-06-05T07:58:12.345Z",
  "closed_at": "",
  "owner": "张三",
  "scheduled_at": null,
  "is_administrable": true,
  "accesses": [ /* owner 视角下额外返回 */ ],
  "livekit": {
    "url": "wss://livekit.we-meet.online",
    "room": "1a2b3c4d-...-uuid",
    "token": "<jwt-room-token>"
  }
}
```

| 关键字段 | 用途 |
|---------|------|
| `id` | 后续所有 `/rooms/{id}/...` 请求的 path 参数；也是 LiveKit 房间名 |
| `livekit.url` / `livekit.token` | `LiveKit.connect(url, token)` 直连 LiveKit 用 |
| `livekit.token` | **同时也是 `start-ai-agent` / `stop-ai-agent` 的 Bearer** |

**错误**：
- `401 Unauthorized` — 缺少或非法 OIDC token
- `400 Bad Request` — `access_level` 不在枚举内 / 字段校验失败

> 实现：[`viewsets.RoomViewSet`](../../src/backend/core/api/viewsets.py) `perform_create` + `RoomSerializer.to_representation`。owner 关系在 `perform_create` 中创建。

---

### 4.2 获取 AI 模型目录

`GET /api/v1.0/rooms/ai-agent-config/`

**鉴权**：可选（`permission_classes=[]`）。带 OIDC bearer 时会返回该用户的 `user_preference`，匿名请求 `user_preference: null`。

**200 OK**：

```json
{
  "profiles": [
    {
      "code": "qwen-omni-realtime",
      "display_name": "Qwen Omni 实时",
      "agent_type": "video",
      "voices": [
        { "id": "uuid", "value": "ethan", "label": "男声 · 沉稳" }
      ],
      "default_voice_id": "uuid"
    },
    {
      "code": "doubao_s2s",
      "display_name": "豆包 S2S",
      "agent_type": "audio",
      "voices": [ ... ],
      "default_voice_id": "uuid"
    }
  ],
  "prompts": [
    {
      "id": "uuid",
      "label": "通用助手",
      "content": "你是一个友好的中文助手……"
    }
  ],
  "user_preference": {
    "profile_code": "qwen-omni-realtime",
    "voice_id": "uuid",
    "prompt_id": "uuid"
  }
}
```

| 字段 | 说明 |
|------|------|
| `profiles[].code` | 后端唯一标识；`start-ai-agent` 的 `profile_code` 必须传它 |
| `profiles[].agent_type` | **`audio` / `video`** — 用户层面的用途分类，App 据此挑选「打电话」/「视频通话」对应的 profile，无需匹配 `code` 字符串 |
| `profiles[].voices[].id` | 传给 `start-ai-agent.voice_id`（UUID） |
| `profiles[].default_voice_id` | 未显式选音色时的兜底（音色仍与 profile 绑定） |
| `prompts[].id` | 传给 `start-ai-agent.prompt_id` |
| `user_preference` | 用户上次 `start-ai-agent` 时保存的偏好（profile/voice/prompt） |

> 后端模型还有一个 `architecture` 字段（`omni` / `pipeline`），是 agent worker 内部用的 pipeline 形状，**不下发给客户端**。客户端只看 `agent_type`。

> **prompt 与 profile 解耦**：profile 不再携带 `default_prompt_id`，prompt 目录是独立维度。未显式传 `prompt_id` 时，后端只会按用户偏好兜底；都没有则不带 prompt（agent 走内置行为）。这样换模型不影响已选的 prompt，反之亦然。

**Profile 选择策略（App 端 [`AiAgentConfigResponse.videoProfile/voiceProfile`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/model/AiCallDtos.kt)）：**

- 视频模式：首选 `agent_type == "video"` 的 profile；后端旧版无 `agent_type` 时兜底为 `code` 含 `qwen`
- 语音模式：首选 `agent_type == "audio"` 的 profile；后端旧版兜底为 `code` 含 `doubao` + `s2s`

> 后端会兜底返回 `{profiles: [], prompts: [], user_preference: null}` 而不抛 500，便于前端做空状态展示。

---

### 4.3 启动 AI Agent

`POST /api/v1.0/rooms/{id}/start-ai-agent/`

**鉴权**：`Authorization: Bearer <livekit_token>` + `No-Auth: 1`（详见 §3）。

**Path 参数**：`{id}` = `4.1` 返回的房间 UUID。

**请求体**：

```json
{
  "profile_code": "qwen-omni-realtime",
  "voice_id": "uuid-or-null",
  "prompt_id": "uuid-or-null"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `profile_code` | string | 是 | 取自 `4.2.profiles[].code` |
| `voice_id` | UUID | 否 | 取自 `4.2.profiles[].voices[].id`；未传则按用户偏好 → profile 默认音色兜底 |
| `prompt_id` | UUID | 否 | 取自 `4.2.prompts[].id`；未传则按用户偏好兜底，再无则不带（profile **不**自带默认 prompt） |

**200 OK**：

```json
{
  "status": "success",
  "profile_code": "qwen-omni-realtime",
  "voice_id": "<resolved-uuid-or-null>",
  "prompt_id": "<resolved-uuid-or-null>"
}
```

返回中的 `voice_id` / `prompt_id` 是**实际生效**的 id（含兜底解析）。

**副作用**：
- 服务端调用 LiveKit Agent Dispatch，触发 agent worker 加入房间，`identity` 形如 `ai-agent-<rand>`（App 端用 `identity.startsWith("ai-agent")` 识别）
- 服务端把当前选择写入 `UserAIPreference`（用户认证态下生效），下次拉 `ai-agent-config` 时返回

**错误**：
- `400 Bad Request` — `{"error": "AI agent profile '<code>' is not available."}`，profile 不存在或已禁用
- `400 Bad Request` — DRF 字段校验失败（`profile_code` 缺失，UUID 格式错）
- `401 Unauthorized` — Authorization 头缺失、非 Bearer 形式、token 无效或无 identity
- `403 Forbidden` — LiveKit token 的 `video.room` 与 path 中的 `{id}` 不匹配
- `500 Internal Server Error` — `{"error": "<AIAgentException msg>"}`，LiveKit Agent Dispatch 失败

> App 端不需要轮询确认 agent 是否加入：用 LiveKit `RoomEvent.ParticipantConnected` 监听 `identity.startsWith("ai-agent")` 即可（10s 超时）——见 [`AiCallViewModel.awaitAgentJoin`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/vm/AiCallViewModel.kt)。

---

### 4.4 停止 AI Agent

`POST /api/v1.0/rooms/{id}/stop-ai-agent/`

**鉴权**：`Authorization: Bearer <livekit_token>` + `No-Auth: 1`。

**请求体**：空。

**200 OK**：

```json
{ "status": "success" }
```

**错误**：
- `401 / 403` 同 §4.3
- `500 Internal Server Error` — `{"error": "<AIAgentException msg>"}`，移除 agent 失败

**典型调用时机**：
- 用户挂断（`endCall()`）：先 stop-ai-agent，再 end 房间
- 语音 ↔ 视频热切换（`switchModeHot`）：因为 profile 要从 doubao_s2s 换到 qwen-omni（或反过来），必须 stop 旧 agent → start 新 agent

---

### 4.5 结束房间

`POST /api/v1.0/rooms/{id}/end/`

**鉴权**：OIDC Bearer。

**权限**：仅房主（`HasPrivilegesOnRoom` + `room.is_owner(user)` 二次检查）。AI 会话是当前用户创建，自然是房主。

**请求体**：空。

**200 OK**：

```json
{
  "status": "success",
  "ended_at": "2026-06-05T08:12:34.567Z"
}
```

**副作用**：
- 设置 `room.ended_at`，此后房间无法再次加入（`RoomSerializer.to_representation` 不再下发 `livekit` 块）
- 通过 LiveKit ParticipantsManagement 踢出所有参会者（含 ai-agent worker）

**错误**：
- `400 Bad Request` — `{"error": "Room is already ended."}`
- `403 Forbidden` — `{"detail": "Only the room owner can end the room."}`

> App 端 `endCallAsync` 有兜底重试：第一次 `end` 失败时 sleep 2s 再调一次（[`AiCallViewModel.endCallAsync`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/vm/AiCallViewModel.kt)）。整个清理流程被 `withTimeoutOrNull(15_000)` 包裹，避免阻塞 UI。

---

## 5. 错误码汇总

| HTTP | 出现场景 | 响应体 |
|------|---------|--------|
| 200 | 正常返回 | 接口定义 |
| 201 | 房间创建成功 | RoomSerializer 序列化结果 |
| 400 | 入参校验失败 / profile 不存在 / 房间已结束 | `{"error": "..."}` 或 DRF 字段错误字典 |
| 401 | OIDC token 缺失/失效（默认 endpoint）；LiveKit token 缺失/格式错（agent endpoint） | DRF 默认 |
| 403 | LiveKit token 与 path room id 不匹配；非房主调用 end | `{"detail": "..."}` |
| 500 | LiveKit Agent Dispatch 失败 | `{"error": "..."}` |

---

## 6. App 端关键约定速查

| 约定 | 取值 | 出处 |
|------|------|------|
| AI 会话房间名前缀 | `__JUSI_AI_SESSION__-<millis>` | `AiCallViewModel.runConnectFlow` |
| AI agent 识别 | `identity.startsWith("ai-agent")` | `AiCallViewModel.awaitAgentJoin` / `updateAudioLevel` |
| agent 加入超时 | 10s | `AiCallViewModel.awaitAgentJoin` |
| 摄像头发布超时 | 10s | `AiCallViewModel.publishCameraAndAwait` |
| 清理总超时 | 15s | `AiCallViewModel.endCallAsync` |
| end 失败重试 | 1 次，间隔 2s | `AiCallViewModel.endCallAsync` |

---

## 7. 相关代码 / 文档

**App 端：**
- [`AiAgentApi.kt`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/data/AiAgentApi.kt) — Retrofit 接口（带 `No-Auth` + 显式 Authorization）
- [`RoomApi.kt`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/data/RoomApi.kt) — 创建/结束房间
- [`AiCallDtos.kt`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/model/AiCallDtos.kt) — 请求 / 响应 DTO
- [`AiCallViewModel.kt`](../../we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/vm/AiCallViewModel.kt) — 连接 / 切换 / 清理编排

**后端：**
- [`viewsets.RoomViewSet.ai_agent_config` / `start_ai_agent` / `stop_ai_agent` / `end`](../../src/backend/core/api/viewsets.py)
- [`services/ai_agent_providers.py`](../../src/backend/core/services/ai_agent_providers.py) — profile/voice/prompt 解析
- [`services/ai_agent.py`](../../src/backend/core/services/ai_agent.py) — `AIAgentService` LiveKit dispatch
- [`authentication/livekit.py`](../../src/backend/core/authentication/livekit.py) — `LiveKitTokenAuthentication`
- [`api/permissions.py:HasLiveKitRoomAccess`](../../src/backend/core/api/permissions.py)

**测试：**
- [`tests/rooms/test_api_rooms_ai_agent.py`](../../src/backend/core/tests/rooms/test_api_rooms_ai_agent.py)
- [`tests/services/test_ai_agent.py`](../../src/backend/core/tests/services/test_ai_agent.py)

**关联文档：**
- [移动端API接口文档.md](移动端API接口文档.md) — 房间管理 / OIDC 鉴权基础接口
- [docs/features/ai_assistant.md](../features/ai_assistant.md) — AI agent 架构与模型目录设计说明
