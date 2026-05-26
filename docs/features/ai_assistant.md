# AI 助手（音视频互动）

## 背景

we-meet 此前没有 AI 助手能力。本功能让会议参与者可以一键召唤一个"会听、会看、会说"的 AI 加入 LiveKit 房间——AI 通过 Doubao（豆包）或 Qwen（千问）多模态实时大模型，与用户进行音视频交互。

参考实现位于 `D:\workspace\Meeting\jusi_meet_suite1.9`。该项目采用**手写 WebSocket 客户端 + 裸 livekit-rtc**的方式构建 worker（约 2970 行 Python）。但 we-meet 的 `src/agents/` 子项目**已经在使用 livekit-agents 1.4.5 + AgentSession 范式**（见 `multi_user_transcriber.py`），完全照搬手写方式属于反向迁移。

本方案采用**更轻量、可演进的集成方式**：MVP 阶段直接复用 dashscope SDK（其已经包装好 ws 协议与回调），统一在 `src/agents/ai_assistant.py` 入口下；Sprint 2 阶段加入 Doubao 二进制协议适配；后期视 livekit-agents 上游进度逐步迁移到 `RealtimeModel` 抽象。整体新增代码量约 960 LoC，相比完全照搬减少约 73%，并与现有 agent 范式同构。

落地后用户在工具栏点击「AI 助手」按钮即可召唤 AI 加入会议；AI 可听语音、看摄像头/屏幕共享、并以 TTS 实时回话。

---

## 总体架构

```
[前端]
  MoreOptions ─► AIAssistantToggle ─► useAIAssistant()
                                       │
                                       ▼ POST /api/v1.0/rooms/{id}/start-ai-agent
[后端]
  RoomViewSet.start_ai_agent
    └─ AIAgentService.start_ai_agent(provider, config)
         └─ lkapi.agent_dispatch.create_dispatch(
              agent_name=settings.AI_AGENT_NAME,
              room=room.id,
              metadata={provider, voice, prompt, requester_identity})
                                       │
                                       ▼ LiveKit Server 分派
[Agent Worker] src/agents/ai_assistant.py
  entrypoint(ctx):
    meta = json.loads(ctx.job.metadata)
    bridge = build_bridge(meta)   # qwen → QwenOmniClient；doubao_s2s → DoubaoS2SClient
    await bridge.run(ctx.room, requester_identity)
                                       │
                                       ▼
  Qwen   ─► wss://dashscope.aliyuncs.com/api-ws/v1/realtime  (DashScope SDK)
  Doubao ─► wss://openspeech.bytedance.com/api/v3/realtime/dialogue  (自定义二进制)
```

---

## 实施步骤

### Step 1 — Agent Worker（核心）

**新增** `src/agents/ai_assistant.py`（~150 LoC）
- 仿照 `multi_user_transcriber.py` 写法：`entrypoint(ctx)` + `WorkerOptions(agent_name=...)`
- 从 `ctx.job.metadata` 解析 `provider / voice / prompt / requester_identity`
- 路由到对应的 bridge（Qwen / Doubao S2S）
- agent identity 命名为 `ai-agent-{room.id[:20]}`，与 jusi_meet 的 stop 逻辑对齐

**新增** `src/agents/plugins/qwen/omni_client.py`（~180 LoC）
- 直接复用 jusi_meet 实现，包装 `dashscope.audio.qwen_omni.OmniRealtimeConversation`
- 暴露 `send_audio` / `send_video` / `audio_output_queue` / `close` 接口
- 默认模型 `qwen3-omni-flash-realtime`，默认音色 `Cherry`

**新增** `src/agents/plugins/doubao_s2s/`（Sprint 2，~600 LoC）
- `protocol.py`：二进制帧编解码（直接迁移 jusi_meet）
- `s2s_client.py`：ws 客户端，暴露与 Qwen 同形的接口（`send_audio` / `audio_output_queue`）
- 配置：`DOUBAO_S2S_APP_ID`、`DOUBAO_S2S_ACCESS_KEY`、voice（jupiter 系列）、model（默认 `1.2.1.1`）

**修改** `src/agents/pyproject.toml`
- 添加 `dashscope`、`pillow`、`numpy`、`websockets`

### Step 2 — Backend Service

**新增** `src/backend/core/services/ai_agent.py`（~100 LoC）
- 直接基于 jusi_meet `ai_agent.py`（96 行）迁移
- 简化：单一 `AI_AGENT_NAME`，provider 通过 metadata 传递（jusi_meet 是 1 provider 1 worker）
- 复用现有 `core.utils.create_livekit_client()`

**新增** `src/backend/core/services/ai_agent_providers.py`（~120 LoC）
- 定义 `SUPPORTED_PROVIDERS = ("qwen", "doubao_s2s", "doubao")`
- 配置校验（必填字段、合法的 voice / model 列表）
- 从 DB 加载 `AIVoice` / `AIPrompt`

**新增** `src/backend/core/models.py` 中追加 `AIVoice`、`AIPrompt` 模型（+ migration）
- `AIVoice`：provider、value、label、sort_order、is_active
- `AIPrompt`：label、content、category、sort_order、is_active
- 简化版，不照搬 jusi_meet 全部字段

**修改** `src/backend/core/api/viewsets.py` RoomViewSet 新增 3 个 `@action`（~80 LoC）
- `POST /rooms/{id}/start-ai-agent/`：通过 LiveKit token 鉴权 → 调用 service
- `POST /rooms/{id}/stop-ai-agent/`：调用 `AIAgentService.stop_ai_agent()`
- `GET /rooms/ai-agent-config/`：返回 providers、voices、prompts、defaults

**修改** `src/backend/meet/settings.py`
- 新增 `AI_AGENT_NAME = values.Value("ai-agent", environ_name="AI_AGENT_NAME")`
- 新增 `DASHSCOPE_API_KEY`、`DOUBAO_S2S_APP_ID`、`DOUBAO_S2S_ACCESS_KEY`

### Step 3 — K8s 部署

**新增** `src/helm/meet/templates/agent_ai_assistant_deployment.yaml`
- 基于 `agent_subtitles_deployment.yaml` 复制改名
- 启动命令：`python ai_assistant.py start`
- env 注入：`LIVEKIT_URL`、`LIVEKIT_API_KEY/SECRET`、`AI_AGENT_NAME`、`DASHSCOPE_API_KEY`、`DOUBAO_S2S_*`

**修改** `src/helm/meet/values.yaml`
- 加 `agentAIAssistant.enabled`、`agentAIAssistant.replicas`、`agentAIAssistant.image`、secret 引用

### Step 4 — Frontend UI

**新增** `src/frontend/src/features/ai-assistant/`
- `api/startAIAgent.ts`、`api/stopAIAgent.ts`、`api/getAIAgentConfig.ts`
- `hooks/useAIAssistant.ts`（管理 active 状态，监听 LiveKit room 中 identity 以 `ai-agent-` 开头的参与者）
- `components/AIAssistantPanel.tsx`（provider / voice / prompt 选择器）
- `components/AIAssistantToggle.tsx`（工具栏按钮，调用 panel）

**修改** `src/frontend/src/features/rooms/livekit/prefabs/ControlBar/MoreOptions.tsx`
- 引入 `AIAssistantToggle`，放在 `ToolsToggle` 旁

**新增** `src/frontend/src/locales/{en,fr,de,nl,zh}/ai-assistant.json`
- 标题、按钮文案、provider/voice 描述（中文优先填全）

### Step 5 — 验证

**单元 / 集成测试**
- `src/backend/core/tests/test_ai_agent_service.py`：mock `lkapi.agent_dispatch`，测试 provider 校验、metadata 序列化、stop 行为
- `src/backend/core/tests/test_api_rooms_ai_agent.py`：测试 3 个 endpoint 的鉴权与响应

**端到端冒烟测试**
1. `make bootstrap` + 启动 docker-compose（含 livekit、backend、agents、frontend）
2. 设置环境变量 `DASHSCOPE_API_KEY=sk-xxx`（先打通 Qwen 路径）
3. 浏览器打开 we-meet，创建一个房间并入场
4. 点工具栏 `MoreOptions → AI 助手 → 启动 (provider=qwen)`
5. 观察：
   - 房间内出现 identity 为 `ai-agent-xxxx` 的新参与者
   - 朝麦克风说「你好」，AI 在 1–2 秒内语音回复
   - 打开摄像头展示物体，问 AI「你看到什么了」，AI 能描述
6. 点「停止」 → 房间内 AI 参与者消失
7. 切换 provider=doubao_s2s 重复一次

---

## 关键复用与新增清单

### 直接复用（不改动）
- `src/agents/multi_user_transcriber.py` — agent worker 编写范式
- `src/backend/core/utils.py` `create_livekit_client()` — LiveKit API 客户端工厂
- `src/backend/core/authentication/livekit.py` — token 解析逻辑

### 跨项目迁移
- `jusi_meet ai_agent.py` — 96 行，迁入 we-meet `core/services/ai_agent.py`
- `jusi_meet plugins/qwen/omni_client.py` — DashScope SDK 包装
- `jusi_meet plugins/doubao_s2s/protocol.py` — 二进制协议（Sprint 2）

### 新增文件（合计 ~960 LoC）
- `src/agents/ai_assistant.py`
- `src/agents/plugins/qwen/__init__.py`、`omni_client.py`
- `src/agents/plugins/doubao_s2s/__init__.py`、`protocol.py`、`s2s_client.py`
- `src/backend/core/services/ai_agent.py`
- `src/backend/core/services/ai_agent_providers.py`
- `src/backend/core/migrations/00XX_aivoice_aiprompt.py`
- `src/helm/meet/templates/agent_ai_assistant_deployment.yaml`
- `src/frontend/src/features/ai-assistant/**`
- `src/frontend/src/locales/{en,fr,de,nl,zh}/ai-assistant.json`

### 小幅修改文件
- `src/agents/pyproject.toml` — 加 4 个依赖
- `src/backend/core/models.py` — 加 2 个模型
- `src/backend/core/api/viewsets.py` — 加 3 个 action
- `src/backend/meet/settings.py` — 加 4 个配置项
- `src/helm/meet/values.yaml` — 加 `agentAIAssistant.*`
- `src/frontend/src/features/rooms/livekit/prefabs/ControlBar/MoreOptions.tsx` — 加 1 个 Toggle

---

## 落地节奏

- **Sprint 1（MVP）**：Step 1 仅做 Qwen 路径 + Step 2 + Step 3 + Step 4 主链路。先打通"召唤 → 听到 AI 说话"。
- **Sprint 2**：加 Doubao S2S 客户端、`AIVoice` / `AIPrompt` 后台管理、视频帧多模态体验调优。
- **Sprint 3（可选增值）**：用 `function_tool` 注入会议工具（静音参与者、读取最近字幕、抓屏幕共享帧），让 AI 升级为「会议运营助手」。

---

## 风险与缓解

1. **livekit-agents 1.4.5 API 演进** — 锁版本，pin 到具体小版本。
2. **Qwen-Omni OpenAI 兼容度** — Sprint 1 直接使用 dashscope SDK 已包装的版本，不踩 OpenAI 兼容协议的兼容性坑。
3. **Doubao 二进制协议生命周期对齐** — 移植 protocol.py 后单独写 pytest，mock ws server 验证 send/recv 完整性。
4. **token 权限边界** — 复用 `authentication/livekit.py` 的解析逻辑，确保只有合法房间参与者能召唤 AI；AI agent 的 identity 用 `ai-agent-{room.id[:20]}` 防冲突。
5. **API key 泄露** — 所有密钥仅注入到 agents deployment，不暴露给前端；前端只通过 `/ai-agent-config/` 取非敏感的 voice/prompt 列表。
