# App 端补齐 Web 端功能 — Sprint 1–4 总览

> 配套：[移动端App客户端支持方案.md](移动端App客户端支持方案.md)、[PostHog私有化部署与埋点对接方案.md](PostHog私有化部署与埋点对接方案.md)
> 时间窗口：约 50 个 App 端 commit + 同步的 we-meet 后端/前端改动
> 目标：把 App 客户端从"主路径可用"补齐到接近 Web 端的覆盖面

## 1. 起点与终点

**起点**：App 已跑通 OTP 登录 → 创建/加入会议 → LiveKit 视频通话 → 修改个人资料的主路径。相对 Web 端，在 **主持人能力、会议邀请、字幕/录制、深度链接、本地化** 等多个维度仍有缺口。

**终点**：双端 UI/交互对齐 + 6 个核心事件埋点 + 5 语种 + 三态主题切换 — Sprint 1–4 主干完成。

仓库分支：
- App：`we-meet-android@main`（所有 commit 直接落 main）
- Web/后端：`we-meet@aliyun-dev`（配合 App 路线推进的双端改动）

## 2. Sprint 完成度（按 plan）

| Sprint | 项 | 状态 | 关键 commit |
|---|---|---|---|
| **S1** 主持人 + 邀请 + 深链 | S1.1 主持人识别 | ✅ | `12696d2` |
| | S1.2 会中改名 | ✅ | `12696d2` |
| | S1.3 举手 | ✅ | `efcea5e` |
| | S1.4 踢人 / 禁言 | ✅ | `97b744a` |
| | S1.5 邀请分享 | ✅ | `47fd232` |
| | S1.6 App Links 深链 | ✅ | `b9c90e6` |
| | S1.7 注销账号 | ✅ | `c0b9d81` |
| **S2** 候诊室 + 会议管理 | S2.1 候诊室（owner + visitor） | ✅ | `54422d9` + `cfb5619` |
| | S2.2 会议列表后端化 | ✅ | `3c23266` |
| | S2.3 删除会议 | ✅ | `bcad268`（左滑抽屉） |
| | S2.4 预约会议 | ✅ | `48306d0` + `177ad4b` |
| **S3** 录制 + 字幕 + AI + 详情 | S3.1 录制 | 🚧 | `94bec7f` — 后端 `RECORDING_ENABLE=False`，按钮 stub，banner 订阅保留 |
| | S3.2 实时字幕 | ✅ | `c344a96` |
| | S3.3 Room AI | ✅ | `0ceb72c` — 自写 SSE 客户端 |
| | S3.4 会议详情 | ✅ | `cb0a165` → `cc3dd49`（4 Tab → 单页平铺） |
| **S4** 体验补全 | S4.1 FCM 推送 | 🚧 | 国内 FCM 不可用 |
| | S4.2 多语言 | ✅ | `6ea4b3c` — zh / en / fr / de / nl 5 语 |
| | S4.3 深色模式 | ✅ | `6ae61da` — 跟随系统 / 浅色 / 深色 三态 |
| | S4.4 PostHog 埋点 | ✅ | `f24a301` — key 空时 no-op |
| | S4.5 通知设置 | 🚧 | 随 S4.1 一起搁置 |

**主干完成率**：22 / 25 = **88%**；剩余 3 项都是部署/平台原因暂缓，代码侧已留接入点。

## 3. 主要交付（按代码层）

| 层 | 关键新增 |
|---|---|
| 数据模型 | `HistoryEntry.closedAtMs`、`SubtitleSegment`、`RoomAiMessage`、`ThemeMode`、`StartRecordingRequest` |
| API（RoomApi） | `startRecording / stopRecording / startSubtitle / deleteRoom / listMyRooms / renameParticipant / toggleHand / removeParticipant / muteParticipant / requestEntry / listWaitingParticipants / allowParticipantToEnter` 等 |
| 仓库 | 新建 `RoomAiRepository`（手写 OkHttp SSE 解析）；`RoomRepository` 扩展；`HistoryStore.remove` |
| ViewModel | `RoomViewModel` 加 `isAdmin / waitingParticipants / isRecording / subtitleSegments / aiMessages`；`HomeViewModel` 加 `scheduledMeetings / deleteMeeting` |
| UI 新建 | `InviteSheet`、`WaitingRoomScreen`、`HistoryDetailScreen`、`MeetingDetailViewModel`、`ScheduledMeetingsList`、`SwipeRevealRow`、`SubtitleOverlay`、`RoomAiSheet`、`LoginDialog`、`ScheduleMeetingDialog`、`HostSettingsSheet`、`DeregisterDialog` |
| 本地化 | `values-fr/de/nl` 各 233 字符串；6 个新 Settings 项 |
| 主题 | `WeMeetTheme(darkTheme)` 接 `SettingsStore.themeMode` |
| 分析 | `Analytics` 单例（6 个事件名与 Web `posthog.capture` 对齐） |
| 导航 | `AppNav` 加 `safePop` + `rememberOnceOnly` 全局双击守护；历史条目按 `closed_at` 分流（已结束跳详情 / 未结束跳 preview） |

## 4. 中途的关键 UX 重构

| 改造 | commit | 缘由 |
|---|---|---|
| 会议详情 4 Tab → 单页平铺 | `cc3dd49` | 手机端 Tab 切换不便，平铺上下滑动更顺 |
| 删除会议 ⋮菜单 → 左滑抽屉 | `bcad268`（v3） | iOS 风格更符合手机习惯，右滑回弹关闭代替「取消」按钮 |
| 录制按钮真调 → stub | `94bec7f` | 后端 `RECORDING_ENABLE=False` 导致 404；UI 回退但 banner 订阅保留 |
| 双击返回 → 全局守护 | `6b2349c` | 防止越栈底（空白页）/ 越层（多 pop 一层） |
| Settings 从 Home → Profile tab | `6b3dda7` | language/theme/codec 都是应用级偏好，不该挂在会议入口 |
| 注销账号从 Profile → Settings.账号 | `d05d679` | 集中账号级操作 |
| Sheet 高度 0.5 → 0.618 | `3d55339` | 黄金分割视觉比例，AI sheet + 消息抽屉统一 |
| 更多窗口 1×6 → 5×2 网格 | `4928661` | 设置移到第二行，留出新功能槽位 |
| 预约会议时间从可选改必填 | `0caff7d` + `177ad4b` | 「预约」语义就必须有时间；同时禁选过去时间 |
| 预约会议列表 tertiaryContainer → primaryContainer | `47d0c9d` | 与历史记录图标颜色统一，靠图标形状（Event vs Videocam）区分 |

## 5. 跨双端的 Web 端配合改动

App 推进过程中，we-meet 仓库（`aliyun-dev` 分支）配合做了以下双端协调改动：

| 改动 | 原因 |
|---|---|
| 撤回"强制登录入会" | App 端匿名用户需要能进开放会议 |
| 默认 `RESOURCE_DEFAULT_ACCESS_LEVEL=trusted` | 平衡开放性与隐私 |
| 新增 10 个 demo 账号（13800000000-009） | 双端联调用 |
| `Room.scheduled_at` 字段 + migration | 双端预约会议依赖 |
| Web 新增「预约会议」区 + ScheduledMeetingsList | Home 页对齐 App |
| Web 删除会议 + `useDeleteRoom` mutation | 对齐 S2.3 |
| 纪要 failed 状态统一为「暂无纪要」 | 双端 UX 一致 |
| Web 登录弹窗（QR + 手机号双面板） | 配合 App 扫码登录 + 匿名访问 |
| Helm `MOBILE_AUTH_DEMO_PHONES` 10 号 | 配合 demo 账号 |
| 移动端会议详情：`ask-ai-stream` SSE endpoint | S3.3 用 |

## 6. 推迟项及重启路径

| 项 | 推迟原因 | 当前状态 | 重启所需 |
|---|---|---|---|
| **S3.1 录制** | aliyun-prod 未部署 LiveKit Egress + 存储 sink | 按钮 stub「功能开发中」；`RoomEvent.RecordingStatusChanged` 订阅 + `RecordingBanner` 保留 | 部署 Egress → 配 S3/OSS sink → 后端 `RECORDING_ENABLE=True` → App `onClick = showStub` 改回 `onClick = onRecordClick` |
| **S4.1 FCM 推送** | 国内 FCM 不可用 | 未做任何代码 | 切国内推送 SDK（小米/华为/OPPO/Vivo/极光等），新建 FirebaseMessagingService 等价的 Service |
| **S4.5 通知设置** | 随 S4.1 一起 | 未做任何代码 | 通知 channel + 偏好 UI |
| **PostHog 部署** | aliyun-sjy 资源紧张（4C8G） | 双端代码已就绪，key 空时 no-op | 见 [PostHog私有化部署与埋点对接方案.md](PostHog私有化部署与埋点对接方案.md)，扩容到 6C16G 即可部署 |

## 7. Memory 沉淀

为避免后续讨论重复触雷，沉淀了 4 条 project memory（位于 `~/.claude/projects/d--workspace-we-meet-we-meet/memory/`）：

| memory | 内容 |
|---|---|
| `project-recording-disabled.md` | 录制 endpoint 当前 404，资源未到位 |
| `project-fcm-deferred.md` | FCM 国内不可用，连同 S4.5 一起搁置 |
| `project-rerank-deferred.md` | Sprint 2.6.x rerank 推迟（与 App 线无直接关系，AI 线决策） |
| `project-clustering-deferred.md` | Sprint 2.7 主题聚类推迟 |

## 8. 验证清单（按 Sprint 验收）

### Sprint 1
- [x] App 端会议中 owner 看到「主持人设置」「踢人」「禁言」入口；非 owner 看不到
- [x] 双端同房间互通：A 端举手/改名 → B 端看到
- [x] 浏览器点 `https://we-meet.online/12345678` → 直进 App PreviewScreen
- [x] 注销账号确认对话框需输入手机号匹配才能确认

### Sprint 2
- [x] App 候诊室：访客 PreviewScreen 提交后停在 WaitingRoomScreen 轮询；owner 端看到 banner + 列表
- [x] 跨设备：A 设备建会议，B 设备 Home 历史区能看到（refreshRemoteRooms）
- [x] 历史/预约条目左滑露出红色「删除」按钮，确认后调 DELETE 同步消失
- [x] 预约会议 DatePicker 拒绝选过去日期；TimePicker + 今天的过去时间 → 确认按钮 disabled

### Sprint 3
- [x] 字幕：More → 字幕 → 按钮变蓝 + 底部红条 + 转录条按 speaker 分组
- [x] Room AI：More → AI → 黄金分割 sheet 弹出，问问题流式打字机回答；多轮上下文有效
- [x] 历史详情：4 section（信息/纪要/行动项/字幕）平铺；纪要 failed 显示「暂无纪要」
- [x] 历史条目点击：closed_at 非空 → detail；为空 → preview（rejoin）

### Sprint 4
- [x] Settings → 主题 → 选「深色」→ UI 立即变；杀进程重启保留
- [x] Settings → 语言 → 切到 Français → 全 UI 切换；非 Settings 字符串也跟着
- [x] PostHog 单元接入：BuildConfig key 空时 `Analytics.init` 走 no-op 分支；非空时调 `PostHogAndroid.setup`

## 9. 关键技术决策

| 决策 | 选择 | 原因 |
|---|---|---|
| 字幕状态保存位置 | 独立 `StateFlow<List<SubtitleSegment>>` | 高频 `TranscriptionReceived` 事件不能挂在 `RoomUiState` 上，会拖累整页 recompose |
| Room AI SSE 客户端 | 手写 OkHttp `BufferedSource.readUtf8Line` | 不引 `okhttp-sse` 新依赖；后端帧格式简单（`data: <json>\n\n`） |
| Subtitle 启动后无法关闭 | UI 切显隐 + 后端只 start 不 stop | 后端契约：`start-subtitle` endpoint 单向，agent 跟会议生命周期 |
| 双击返回守护 | AppNav 全局 `safePop` + 每 destination `rememberOnceOnly` | 两层防御覆盖「越栈底」和「越层」两种场景 |
| 主题切换实现 | `AppCompatDelegate.setApplicationLocales` + `WeMeetTheme(darkTheme)` 接 SettingsStore | 不写自定义 ConfigurationOverride，依赖 AppCompat 1.7+ 的官方机制 |
| 分析 SDK 选型 | PostHog（继承 Web） | 双端事件名对齐，单 dashboard 统计；可私有化部署 |
| 录制按钮 stub 处理 | UI 回退但事件订阅保留 | Web 端将来启动录制时，App 端 banner 仍能正确显示 |

## 10. 相关文档

- [移动端App客户端支持方案.md](移动端App客户端支持方案.md) — Sprint 0 设计：OTP 登录、8 位数字 slug、个人资料的初期方案
- [移动端API接口文档.md](移动端API接口文档.md) — 移动端调用的 backend endpoint 清单
- [移动端上线检查清单.md](移动端上线检查清单.md) — 发布前 checklist
- [移动端扩展功能部署步骤.md](移动端扩展功能部署步骤.md) — 在已运行的阿里云部署上滚动升级移动端改动
- [PostHog私有化部署与埋点对接方案.md](PostHog私有化部署与埋点对接方案.md) — 资源到位后启用 PostHog 的步骤

## 11. App 端模块结构（终态）

```
com.we.meet
├── WeMeetApp.kt              # Application: tokenStore / apiClient / 各 repo / Analytics.init
├── MainActivity.kt            # AppCompatActivity (locale 切换需要), 持 themeMode
├── analytics/Analytics.kt     # PostHog 单例
├── data/
│   ├── api/
│   │   ├── RoomApi.kt        # ~20 个 endpoint
│   │   ├── dto/              # StartRecordingRequest / RaiseHandRequest / RemoveParticipantRequest 等
│   │   └── ApiClient.kt      # Retrofit + OkHttp + AuthInterceptor + TokenRefreshAuthenticator
│   ├── auth/                  # TokenStore / AuthInterceptor / TokenRefreshAuthenticator
│   ├── chat/                  # ChatMessageUi
│   ├── history/HistoryEntry.kt + HistoryStore.kt
│   ├── repository/
│   │   ├── RoomRepository.kt
│   │   ├── RoomAiRepository.kt    # 手写 SSE
│   │   ├── ProfileRepository.kt
│   │   ├── MeetingDetailRepository.kt
│   │   └── QrLoginRepository.kt
│   └── settings/SettingsStore.kt + VideoCodecPref + ThemeMode
├── livekit/LiveKitController.kt  # Thin wrapper over LiveKit Room (events)
├── service/ConferenceForegroundService.kt  # 前台 service 显示「正在会议中」
├── overlay/ScreenShareOverlay.kt # 屏幕分享时的悬浮控件
└── ui/
    ├── theme/                 # WeMeetTheme + Color/Type
    ├── nav/AppNav.kt          # NavHost, safePop + rememberOnceOnly 守护
    ├── login/                  # phone OTP
    ├── home/
    │   ├── HomeScreen.kt
    │   ├── HomeViewModel.kt
    │   ├── HistoryList.kt + ScheduledMeetingsList.kt
    │   └── SwipeRevealRow.kt   # 通用左滑抽屉
    ├── main/MainTabScreen.kt   # 3 个底部 tab: 会议 / AI / 我
    ├── profile/ProfileScreen.kt
    ├── settings/SettingsScreen.kt  # codec / theme / language / 账号注销
    ├── preview/PreviewScreen.kt
    ├── waiting/WaitingRoomScreen.kt
    ├── history/
    │   ├── HistoryDetailScreen.kt   # 单页平铺 4 section
    │   └── MeetingDetailViewModel.kt
    ├── qrscan/                 # QR 登录扫描
    └── room/
        ├── RoomScreen.kt       # 主舞台 + TopToolbar + BottomToolbar + MoreSheet
        ├── RoomViewModel.kt    # 状态机 + LiveKit 事件订阅 + AI 流
        ├── SubtitleOverlay.kt
        ├── RoomAiSheet.kt
        ├── MessagesPanel.kt    # ModalBottomSheet 抽屉, 0.618 高
        ├── InviteSheet.kt
        ├── HostSettingsSheet.kt
        ├── ParticipantTile.kt
        └── PipLayout.kt        # PiP 模式精简布局
```
