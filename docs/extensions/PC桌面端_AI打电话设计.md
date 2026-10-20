# PC 桌面端 AI 打电话设计方案

> 状态：设计稿，待评审  
> 日期：2026-10-20  
> 范围：C 端 Windows / macOS 桌面端，优先浏览器 Web，第二阶段 Electron 外壳  
> 目标：复刻 Android AI 打电话的语音、摄像头、屏幕共享、读屏和通话记录体验  
> 参考：[Android AI 音视频交互](../features/ai-audio-video-interaction.md)、[客户端多端策略](客户端多端策略_对标飞书.md)

## 1. 结论

可以做，且推荐复用现有 Web/后端能力，不直接移植 Android 实现。

核心判断：

1. **桌面端优先用现有 React Web 前端 + WebRTC 实现**，不新写原生桌面 UI；
2. **Electron 只做外壳和桌面能力增强**，不重写业务；
3. **屏幕共享使用浏览器/Electron 的 `getDisplayMedia`**，不使用 Android MediaProjection；
4. **读屏不再需要无障碍服务**，直接从共享视频轨抓帧，复用现有 photo QA；
5. **第一期只支持 WebRTC，不支持 AOQ**；
6. **摄像头和屏幕共享互斥**，共用一个 video sender，通过 `replaceTrack` 切换；
7. **桌面端没有系统级“读取任意应用”的能力**，只能读取用户主动选择共享的窗口/屏幕；
8. **PC 主入口是 AI 对话浮窗，不是独立“打电话”页面**：通话是对话浮窗里的一种模式，主窗口继续保留对话内容。

预期能力对齐度：

| 能力 | 桌面端 |
|---|---|
| 实时语音通话 | 完全可复刻 |
| 摄像头视频 | 完全可复刻 |
| 屏幕/窗口共享 | 可复刻，但每次需系统选择器 |
| AI 读屏 | 可复刻，基于共享画面抓帧 |
| 语音控制摄像头/结束通话 | 可复刻 |
| 对话浮窗内发起通话 | Electron 可复刻；浏览器用 Document PiP/侧栏降级 |
| 通话中继续查看对话 | 可复刻，浮窗和主窗口共享会话 |
| 通话记录/摘要/待办 | 可复刻，存储从 SQLite 改为 IndexedDB |
| Android 无障碍兜底 | 不需要，也无法复刻 |
| 后台常驻/全局快捷键 | 浏览器做不到，需 Electron 桌面壳 |

## 2. 产品与工程边界

### 2.1 本期目标

- 在 AI 对话浮窗顶部直接发起 AI 通话；
- PC 上发起 AI 语音通话；
- 打开/关闭摄像头；
- 共享窗口、整个屏幕或浏览器标签页；
- AI 通过共享画面读取内容；
- 语音结束通话；
- 主窗口和浮窗共享同一份对话、通话状态和截图；
- 本地通话记录、摘要和待办；
- Windows / macOS 主流程可用。

### 2.2 非目标

- 不在第一期做 AOQ；
- 不实现 Android 无障碍读屏；
- 不实现系统级录制任意后台窗口；
- 不实现多人会议内的 AI Agent；
- 不实现系统音频共享；
- 不实现原生 C++/Qt 客户端；
- 不做移动端和 PC 端历史自动云同步；
- 不把“打电话”做成独立二级页面入口。

## 3. 技术选型

| 层 | 选型 | 原因 |
|---|---|---|
| UI | 现有 React / Vite / panda-css | 复用 Web 组件和设计系统 |
| 桌面外壳 | Electron | 复用 Chromium WebRTC，和 Web 行为一致 |
| 实时传输 | WebRTC | 后端已支持 SDP；浏览器原生可用 |
| 屏幕采集 | `getDisplayMedia` / Electron `desktopCapturer` | Chromium 标准能力 |
| 读屏 | 共享视频帧 + Canvas JPEG + photo QA | 不依赖 Android 无障碍 |
| 本地历史 | IndexedDB（浏览器）/ Electron userData | 无 SQLite 原生依赖 |
| 身份认证 | 复用 Web OIDC / 现有登录态 | 不新建账号体系 |
| 更新 | Electron updater（首版后接入） | 桌面分发需要 |

### 3.1 为什么不是原生桌面

- UI 不能复用 React；
- WebRTC、屏幕采集、设备管理要重写；
- 与 Web 端行为容易分叉；
- 团队现有桌面策略已经明确选择 Electron（见多端策略文档）。

### 3.2 为什么不用 AOQ

- AOQ 是移动端 SDK；
- 浏览器没有对应 AOQ 客户端；
- 第一期使用 WebRTC 即可覆盖语音和屏幕共享；
- 后续若需要更低延迟，再评估 AOQ 桌面 SDK 或原生壳。

## 4. 总体架构

```mermaid
flowchart LR
    subgraph Client[PC 客户端]
        Main[主窗口：AI 对话]
        Float[对话浮窗：通话模式]
        IPC[Electron IPC / 状态同步]
        Store[Conversation + Call Store]
        Media[媒体设备管理]
        Capture[屏幕采集]
        Frame[视频帧抓取]
        History[IndexedDB 历史]
        RTC[RTCPeerConnection]
        Shell[Electron main/preload]
        Main <--> IPC
        Float <--> IPC
        IPC <--> Store
        Store --> Media
        Store --> Capture
        Store --> Frame
        Store --> History
        Media --> RTC
        Capture --> RTC
        Shell --> Capture
    end

    subgraph Backend[业务后端]
        API[ai-call 配置/SDP/租约]
        Photo[photo QA]
        Summary[摘要/待办]
    end

    subgraph Aliyun[阿里云百炼]
        Realtime[Qwen Realtime]
    end

    Main -->|HTTPS 登录态| API
    Float -->|HTTPS session_id| Photo
    Store -->|HTTPS| Summary
    RTC <-->|WebRTC 音频/视频/DataChannel| Realtime
    API -->|服务端 Key 分配| Realtime
```

桌面端只负责客户端媒体和交互；模型 Key、服务端 SDP 交换和租约仍在业务后端。

### 4.1 主窗口与浮窗的职责

| 窗口 | 职责 |
|---|---|
| 主窗口 | AI 对话、历史消息、屏幕共享图片、通话中的“通话中”胶囊 |
| 对话浮窗 | 常驻置顶、拖动/固定/最小化；发起通话；通话中的头像/状态/控制按钮 |
| Call Store | 唯一通话状态机，持有 WebRTC 和媒体轨道 |
| 主进程 | 窗口管理、源选择器、托盘、通知、全局快捷键 |

推荐由**浮窗持有通话媒体**：

- 从主窗口点击电话按钮，主进程创建或唤醒浮窗；
- 浮窗启动麦克风/摄像头/共享；
- 主窗口通过 IPC 接收通话状态和最终文本；
- 浮窗关闭时结束通话并通知主窗口，避免媒体成为孤儿。

### 4.2 浏览器降级

没有 Electron 时：

- 主窗口内使用右侧通话面板；
- 可用 Document Picture-in-Picture 提供近似浮窗；
- 不支持 Safari/Firefox 的常驻置顶，明确降级；
- 媒体层与 Electron 共用。

## 5. 会话建立

### 5.1 接口

复用现有 AI 打电话接口：

```text
GET  /api/v1.0/rooms/ai-agent-config/
POST /api/v1.0/ai-call/session/
POST /api/v1.0/ai-call/photo/
POST /api/v1.0/direct-ai/sessions/{id}/  operation=heartbeat|close
```

第一期请求固定：

```json
{
  "profile_code": "<omni profile code>",
  "transport": "webrtc",
  "photo_qa": true,
  "sdp": "<audio + pre-negotiated video m-line>"
}
```

### 5.2 预协商视频轨

不能等用户点“共享屏幕”时才新增视频 m-line。

正确顺序：

```text
创建 RTCPeerConnection
→ addTransceiver("video", { direction: "sendonly" })
→ addTransceiver("audio", { direction: "sendonly" })
→ createOffer / setLocalDescription
→ POST SDP
→ setRemoteDescription(answer)
→ 语音阶段 video sender 不挂真实轨道
→ 摄像头/屏幕共享时 replaceTrack(track)
```

这样切换摄像头和屏幕不会触发后端不支持的重新协商。

### 5.3 建连时序

```mermaid
sequenceDiagram
    autonumber
    participant UI as PC 客户端
    participant API as 业务后端
    participant Qwen as Qwen Realtime

    UI->>API: GET ai-agent-config
    API-->>UI: profile / voice / prompt
    UI->>UI: 预加 audio/video transceiver
    UI->>API: POST ai-call/session（webrtc + SDP）
    API->>Qwen: 服务端 Key 交换 SDP
    Qwen-->>API: SDP answer
    API-->>UI: sdp / voice / instructions / lease
    UI->>Qwen: setRemoteDescription
    UI->>Qwen: DataChannel session.update
    Qwen-->>UI: session.updated
    UI->>UI: 启动麦克风并进入语音通话
```

### 5.4 租约

- 使用返回的 `session_lease`；
- 按 `heartbeat_seconds` 发送 heartbeat；
- `enforce=true` 时租约失败结束通话；
- 挂断时 best-effort `close`；
- 不能把租约 TTL 当成模型连接生命周期。

## 6. 媒体链路

### 6.1 麦克风

```ts
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
})
```

要求：

- 首次点击“开始通话”后申请权限；
- 音频通过 `RTCRtpSender.replaceTrack` 挂到 audio transceiver；
- 真正拿到音频轨并通过 `session.updated` 后才显示“通话中”；
- 麦克风静音只控制本地音轨，不停止采集。

### 6.2 摄像头

- 使用 `getUserMedia({ video: ... })`；
- 本地预览和发送共用同一条轨道；
- 摄像头开关通过 video sender `replaceTrack`；
- 关闭时停止轨道，释放指示灯；
- 停止共享后是否恢复摄像头，必须由明确状态决定，不根据模型回复推断。

### 6.3 屏幕共享

浏览器：

```ts
navigator.mediaDevices.getDisplayMedia({
  video: {
    frameRate: { ideal: 15, max: 30 },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
  // Chromium 专用约束
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
})
```

Electron：

- main 进程 `desktopCapturer.getSources()` 提供源列表；
- 使用 `session.setDisplayMediaRequestHandler`；
- 不默认选中 We Meet 自己的窗口；
- 仍保留系统/应用选择器，不静默抓屏。

行为：

1. 用户点击“共享屏幕”；
2. 出现系统源选择器；
3. 用户选择窗口/屏幕/标签页；
4. 停止摄像头轨道；
5. `videoSender.replaceTrack(screenTrack)`；
6. 共享结束、用户点浏览器停止条或 track `ended`：
   - 停止 screen track；
   - 清空/恢复 video sender；
   - 按原状态恢复摄像头；
   - 更新 UI 和工具列表。

### 6.4 音频播放

- 远端 AI 音频通过 `<audio autoplay>` 或 Web Audio 播放；
- 浏览器自动播放限制：必须由“开始通话”点击解锁；
- 支持输出设备选择（`setSinkId`，浏览器支持范围内）；
- “静音播放”只控制输出，不影响工具事件和文本记录。

### 6.5 没有远端视频

AI 通话只有本地摄像头/屏幕预览和远端音频。  
不需要渲染远端视频轨；不要为 AI 创建视频接收画面。

## 7. 屏幕读取

### 7.1 原则

桌面端不实现 Android 无障碍截图。

读屏来源必须是用户当前主动共享的：

- 窗口；
- 整个屏幕；
- 浏览器标签页。

不能读取未共享的另一个应用。

### 7.2 工具

`read_screen` 只在屏幕共享且画面可见时提供给模型。

工具流程：

```text
模型调用 read_screen
→ 检查当前 share track 是否 active
→ 从视频轨抓一帧
→ 转 JPEG
→ 调 /api/v1.0/ai-call/photo/
→ photo QA 返回文字
→ function_call_output
→ 继续实时模型回答
```

### 7.3 抓帧

浏览器：

```text
HTMLVideoElement + Canvas
或 ImageCapture.grabFrame()
或 MediaStreamTrackProcessor + VideoFrame
```

要求：

- 使用当前共享轨，不使用摄像头轨；
- 抓帧前确认 track readyState 为 live；
- 目标长边不超过 1920；
- JPEG 质量 85–90；
- Base64 后不超过后端限制（当前 512KB）；
- 展示给用户的截图和上传给 photo QA 的是同一份 JPEG；
- 超时/失败返回 `screen_read_failed`，不自动改读摄像头。

### 7.4 与移动端的差异

| 项目 | Android | PC |
|---|---|---|
| 捕获源 | MediaProjection，失败时无障碍 | 用户选择的 getDisplayMedia 源 |
| 可读范围 | 系统级 | 仅当前共享源 |
| Chrome 兼容 | 部分 OEM 失败 | Chromium 自己采集，通常更稳定 |
| 权限 | 系统投屏 + 可选无障碍 | 每次系统源选择器 |
| 截图持久化 | 本地历史 | 本地 IndexedDB / userData |

## 8. 工具与状态

### 8.1 工具集合

第一期：

```text
set_camera_enabled
get_camera_state
take_photo
read_screen
end_call
```

桌面端没有：

```text
open_app
前后摄像头切换
Android 无障碍相关工具
```

`take_photo` 从当前摄像头轨抓帧；`read_screen` 从当前屏幕轨抓帧。

### 8.2 工具同步

- 共享开始时，发送一次 `session.update`，加入 `read_screen`；
- 停止共享时移除；
- 与移动端一致，增加一次延迟重发，避免 update 与 `response.done` 竞争；
- `read_screen` 的 handler 必须再次校验 `screenSharing && screenVisible`；
- 未共享时模型不应看到该工具。

### 8.3 状态机

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Connecting: 开始通话
    Connecting --> ActiveVoice: session.updated + 音频轨
    Connecting --> Failed: 权限/SDP/租约失败
    ActiveVoice --> ActiveVideo: 摄像头开启
    ActiveVideo --> ActiveVoice: 摄像头关闭
    ActiveVoice --> Sharing: 开始共享
    ActiveVideo --> Sharing: 开始共享（先关摄像头）
    Sharing --> ActiveVoice: 停止共享，原摄像头关闭
    Sharing --> ActiveVideo: 停止共享，恢复摄像头
    ActiveVoice --> Ended: 挂断
    ActiveVideo --> Ended: 挂断
    Sharing --> Ended: 挂断
    Failed --> Connecting: 重试
```

## 9. 入口与窗口交互

### 9.1 豆包参考结论

从豆包 PC 的截图可以确认：

- 通话入口在 **AI 对话浮窗的顶部工具栏**；
- 通话不是跳到独立页面，而是浮窗进入“通话中”模式；
- 主窗口继续保留对话内容；
- 通话中以头像/“正在听”/麦克风/挂断等轻量控件为主；
- 主窗口底部显示“通话中 00:38 / 挂断”胶囊；
- 共享屏幕后，截图作为一条对话消息出现在聊天中；
- 系统底部出现“已共享屏幕给豆包 / 停止”的共享状态条。

因此本方案把 PC 主入口定义为：

> **AI 对话浮窗 + 通话模式**，而不是“AI 打电话”独立页。

### 9.2 主窗口

主窗口继续承载 AI 对话：

```text
┌────────────────────────────────────────────────────┐
│ 豆包 / AI 对话                          —  □  ×   │
├────────────────────────────────────────────────────┤
│ 对话消息……                                         │
│                                                    │
│ [用户] 可以看到我的屏幕吗？                        │
│ [AI]   看不到，你共享后我就能看。                  │
│ [截图] Visual Studio Code                          │
│                                                    │
│         ┌──────────────────────────┐               │
│         │ 通话中 03:34        [挂断] │               │
│         └──────────────────────────┘               │
└────────────────────────────────────────────────────┘
```

主窗口职责：

- 展示完整对话；
- 展示通话中的截图；
- 展示通话胶囊、计时、挂断；
- 点击胶囊重新唤起浮窗；
- 不直接持有 WebRTC 媒体。

### 9.3 对话浮窗

浮窗是独立的 Electron `BrowserWindow`：

```text
┌──────────────────────────────┐
│  AI 模型和应用    —  📌  □  × │
├──────────────────────────────┤
│                              │
│           [头像]             │
│         正在听...            │
│                              │
│  ┌────────────────────────┐  │
│  │ 你好                   │  │
│  │ 你好呀，今天过得怎么样？│  │
│  └────────────────────────┘  │
│                              │
├──────────────────────────────┤
│  [键盘] [共享] [麦克风] [挂断]│
└──────────────────────────────┘
```

要求：

- 无边框、可拖动、可置顶、可最小化；
- 关闭浮窗需要确认“结束通话”；
- 浮窗内保留最近几条对话，不要求展示完整历史；
- 通话计时独立显示；
- 共享时显示“正在共享屏幕”，并提供停止入口；
- 共享停止后恢复麦克风/摄像头状态。

### 9.4 通话模式状态

| 状态 | 浮窗 | 主窗口 |
|---|---|---|
| 未通话 | 普通对话浮窗，顶部显示电话按钮 | 普通对话 |
| 连接中 | 显示“正在连接” | 显示“正在连接”胶囊 |
| 语音中 | 头像 + “正在听” + 控件 + 计时 | 底部“通话中 00:38” |
| 视频中 | 本地摄像头预览 + 控件 | 底部通话胶囊 |
| 共享中 | 头像/预览 + “正在共享屏幕” + 停止 | 对话中插入共享截图 + 系统共享条 |
| 已结束 | 回到普通对话浮窗 | 胶囊消失，保留文字和截图 |

### 9.5 共享屏幕交互

入口：

- 浮窗底部“共享”按钮；
- 或主窗口通话胶囊中的“共享屏幕”。

流程：

1. 显示共享同意说明；
2. 打开系统源选择器；
3. 用户选择窗口/屏幕/标签页；
4. 停止摄像头，替换 video track；
5. 主窗口插入一条截图消息；
6. 系统底部显示共享状态条；
7. 用户点击“停止共享”或系统停止条；
8. 停止屏幕轨，恢复摄像头/语音状态。

共享同意：

```text
共享屏幕？
AI 助手可以看到你选择的窗口/屏幕。
共享期间可随时停止。
[取消] [开始共享]
```

不使用 Android 无障碍说明；不承诺读取未共享应用。

### 9.6 可选的全屏通话页

第一版不要求全屏通话页。

如果后续需要：

- 从浮窗“展开”进入；
- 左侧视频/共享预览，右侧完整对话；
- 作为浮窗的放大态，不改变底层 Call Store。

### 9.7 桌面增强

Electron 首版就应具备：

- 对话浮窗置顶/固定；
- 托盘；
- 系统通知；
- 多显示器源选择；
- 开机启动（可选）。

第二阶段再加：

- 全局快捷键；
- 悬浮球；
- 会议/通话快捷唤起；
- 自动更新。

## 10. 历史记录

### 10.1 存储

浏览器使用 IndexedDB，Electron 使用 userData 下的 IndexedDB/文件：

```text
sessions
  id, kind, startedAt, endedAt, mode, transport, title, summary, ...
rows
  id, sessionId, order, role, text, imageBlob
summaries
  sessionId, content, tasks
```

第一期字段：

- `startedAt` / `endedAt`；
- `role`；
- `text`；
- 图片 Blob（屏幕/拍照）；
- 摘要和待办。

PC 端可以直接记录**明确的**：

```text
mode: voice | video | screen
outcome: completed | interrupted | failed
```

避免像 Android 当前一样靠时长推断状态。

### 10.2 保留与隐私

- 默认保留最近 200 次；
- 账号隔离；
- 支持单条删除、清空；
- 屏幕截图保存到本机，不自动上传历史；
- 历史说明必须写明：

```text
本机保存文字、通话图片和屏幕读取截图，最多保留最近 200 次。
```

### 10.3 跨端同步

第一期不做。

PC 与 Android 历史各自本地保存；后续如需同步，应通过后端会话记录接口，而不是直接同步 IndexedDB/SQLite。

## 11. 权限、安全与合规

### 11.1 浏览器

- 必须 HTTPS / secure context；
- 麦克风、摄像头、屏幕共享分别授权；
- 屏幕共享每次由用户手势触发；
- 页面关闭/刷新时停止所有 track；
- 不尝试绕过 DRM 或受保护内容。

### 11.2 Electron

- `contextIsolation: true`；
- `nodeIntegration: false`；
- preload 只暴露必要的 `desktopCapturer` 和窗口 API；
- 只允许应用自己的来源加载；
- 屏幕源选择交给 main 进程，不把任意 IPC 暴露给 renderer；
- 不把 DASHSCOPE Key 或服务端 Key 写入客户端。

### 11.3 数据

- 屏幕截图和拍照属于敏感数据；
- 默认只存本机；
- 删除会话时同步删除图片；
- 共享期间 UI 持续显示状态；
- 结束通话立即停止采集。

## 12. 异常处理

| 场景 | 行为 |
|---|---|
| 麦克风拒绝 | 不建连，提示授权 |
| 摄像头拒绝 | 保持语音，提示无法开摄像头 |
| 屏幕选择取消 | 保持当前语音/视频状态 |
| 共享 track 被系统结束 | 清理共享状态，恢复摄像头 |
| photo QA 超时 | 返回 `screen_read_failed`，不读摄像头 |
| SDP 502/503 | 结束连接，提示重试，不自动切换传输 |
| 租约失败 | `enforce=true` 时结束，否则停止 heartbeat |
| 浏览器刷新 | 清理 session，提示重新开始 |
| 页面进入后台 | 浏览器允许媒体继续，但 UI/定时器可能节流；提示保持前台 |

## 13. 测试与验收

### 13.1 自动化

- WebRTC SDP/事件协议单测；
- 工具解析、去重、错误码单测；
- 媒体 track mock：麦克风、摄像头、屏幕；
- IndexedDB 历史增删改查；
- Playwright 使用 fake media：
  - 假麦克风；
  - 假摄像头；
  - `getDisplayMedia` 需人工/Chromium flag 辅助。

### 13.2 手动矩阵

| 平台 | 浏览器 |
|---|---|
| Windows 11 | Chrome / Edge |
| macOS | Chrome / Safari（Safari 仅验证兼容性） |
| Electron | Windows / macOS 安装包 |

每个平台验证：

1. 发起语音通话；
2. 打开/关闭摄像头；
3. 共享窗口；
4. 共享整个屏幕；
5. AI 读取窗口文字；
6. 停止共享恢复摄像头；
7. 挂断释放麦克风/摄像头/屏幕；
8. 历史记录含截图；
9. 拒绝权限、取消共享；
10. 关闭窗口后无残留采集。

### 13.3 验收标准

- 浮窗顶部电话按钮可直接发起通话，不跳转独立页面；
- 主窗口同步显示“通话中”胶囊和计时；
- 关闭浮窗会结束通话并释放媒体，不在后台留下孤儿轨道；
- 重新打开浮窗能恢复当前对话/通话状态；
- 共享截图出现在主窗口对话中；
- 语音延迟与 Web 端 LiveKit 会议同一量级；
- 屏幕共享开始/停止不重连模型；
- 读屏返回的截图与展示给用户的截图一致；
- 摄像头和屏幕不会同时占用；
- 结束后系统摄像头/麦克风指示灯熄灭；
- 无服务端 Key 出现在客户端；
- 历史删除后图片文件同步删除。

## 14. 分阶段落地

### Phase 0：技术验证（3–5 天）

- 浏览器建立 WebRTC，完成 Qwen 语音通话；
- 预协商 video m-line；
- `getDisplayMedia` + `replaceTrack`；
- 从屏幕帧抓图，调 photo QA；
- 验证后端 SDP/租约/photo QA 对 PC 可用。

### Phase 1：Electron 浮窗 MVP（3–4 周）

- 主窗口 AI 对话；
- 对话浮窗，顶部电话入口；
- 浮窗内通话模式；
- 麦克风/摄像头/屏幕共享；
- 主窗口“通话中”胶囊与状态同步；
- 工具调用、读屏；
- 本地历史；
- 基础错误处理和浮窗生命周期。

> 媒体核心仍写成可复用 React 模块，浏览器可独立运行；但首版产品入口按 Electron 浮窗交付。

### Phase 2：浏览器降级（1–2 周）

- 主窗口右侧通话面板；
- Document Picture-in-Picture 近似浮窗；
- Chrome/Edge 支持，Safari/Firefox 明确降级；
- 与 Electron 共用媒体层和 Call Store。

### Phase 3：桌面增强（2 周左右）

- 全局快捷键；
- 托盘/通知/开机启动；
- 悬浮球；
- 多显示器与源选择优化；
- 打包、签名、自动更新。

> 工期为粗略估算，取决于现有 Web 登录、OIDC 回调、AI 对话 UI 和打包基础设施。

## 15. 风险

| 风险 | 等级 | 处理 |
|---|---|---|
| 后端不兼容带 video m-line 的浏览器 SDP | 高 | Phase 0 先验证 |
| photo QA 需要有效 session_id | 高 | 确认现有分配/租约返回值 |
| 主窗口与浮窗状态/媒体归属不一致 | 高 | Call Store 单一所有权 + IPC 协议 |
| 关闭浮窗后媒体成为孤儿 | 高 | 关闭即结束通话并通知主窗口 |
| 屏幕选择器体验比移动端多一步 | 中 | 接受；Electron 再做源记忆 |
| 浏览器后台节流 | 中 | 浮窗/桌面壳；浏览器保持前台 |
| macOS 屏幕录制权限 | 中 | 首次引导系统设置 |
| 受保护窗口黑屏 | 中 | 明确提示，不承诺绕过 |
| IndexedDB 图片占用 | 中 | 200 条上限 + 删除清理 |
| 多窗口 UI 分叉 | 中 | 同一 React 组件 + 两个窗口壳 |
| 多平台测试成本 | 中 | 先 Windows Electron，再 macOS |

## 16. 待确认问题

1. 后端 `ai-call/session` 是否接受包含 video m-line 的浏览器 SDP；
2. photo QA 的 `session_id` 具体来自分配响应还是租约 ID；
3. 现有 Web 登录在 Electron 中是 OIDC PKCE 还是复用 Cookie；
4. 是否需要共享系统音频；
5. 历史是否需要与 Android 同步；
6. 关闭浮窗时是直接结束通话，还是收起到主窗口继续通话；
7. 是否需要全局快捷键作为首版能力；
8. 是否允许 macOS 使用系统屏幕录制权限；
9. Qwen Realtime 的 DataChannel 事件名与浏览器实现是否完全一致；
10. 浮窗和主窗口采用同一 renderer 还是两个 BrowserWindow。

## 17. 关键文件

### 后端

- `src/backend/core/api/ai_call.py`
- `src/backend/core/api/ai_call_photo.py`
- `src/backend/core/services/direct_ai_allocations.py`

### Web

- `src/frontend/src/features/rooms/livekit/prefabs/ControlBar/ControlBar.tsx`
- `src/frontend/src/features/rooms/livekit/prefabs/VideoConference.tsx`
- 新增 `src/frontend/src/features/ai-call/`（通话状态、媒体层、工具层、历史）
- 新增 `src/frontend/src/features/ai-chat/`（主窗口对话、浮窗内容）

### Electron

- 新增 `electron/main/`（窗口管理、浮窗、源选择器、IPC）
- 新增 `electron/preload/`（最小 contextBridge）

### Android 参考

- `we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/rtc/OmniWebRtcClient.kt`
- `we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/rtc/OmniCallTools.kt`
- `we-meet-android/feature-assistant/src/main/java/com/we/meet/feature/assistant/aicall/rtc/ScreenFrameJpeg.kt`

## 18. 最终建议

先做 **Phase 0 技术验证**，随后直接做 **Electron 浮窗 MVP**。

如果 Phase 0 证明：

- 浏览器 SDP 可被后端接受；
- 屏幕轨可替换；
- 抓帧 photo QA 可用；
- 租约/心跳正常；

就把媒体核心封装成 React 模块，接入：

```text
主窗口 AI 对话
+ 对话浮窗
+ 浮窗内通话模式
+ 主窗口通话胶囊
```

浏览器版本作为降级形态，不要求提供与 Electron 完全一致的置顶浮窗。

不要在验证前直接开始原生桌面重写，也不要把 Android 无障碍和 MediaProjection 逻辑带进 PC 方案。
