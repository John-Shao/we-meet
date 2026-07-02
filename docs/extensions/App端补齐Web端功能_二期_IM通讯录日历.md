# App 端补齐 Web 端功能（二期）：IM 补齐 + 通讯录 + 日历 + Tab 改造

> 姊妹篇：《App端补齐Web端功能_总览.md》（一期，会议核心对齐）。
> 本文档是二期的设计方案与实施依据，实现过程中如有偏差以代码为准并回写本文档。

## 1. 背景与差距

Web 端已有消息 / 通讯录 / 日历 / 视频会议 4 大模块（另有审批，暂不在 App 范围）。App 端现状：

| 模块 | Web 端 | App 端现状 | 差距 |
|---|---|---|---|
| 视频会议 | 完整 | 一期已基本对齐 | ≈无 |
| 消息 IM | 群聊、图片/文件/语音、引用/撤回/表情回应/转发、已读回执、@提及 | 1:1 纯文本 MVP，会话列表无名字/头像/预览 | 很大；Android SDK(alpha.1) 落后 Web SDK(alpha.7) |
| 通讯录 | 部门树 + 成员列表/详情 + 发消息 | 零代码 | 全新开发（后端 directory API 已就绪） |
| 日历 | 月/周/日视图、创建日程、邀请、RSVP、关联会议一键入会 | 零代码 | 全新开发（后端 calendar-events API 已就绪） |

**已确认决策**：
- 范围 = IM 一期核心 + 通讯录 + 日历；审批不做。
- 底部 Tab = 消息 · 日历 · 会议 · 通讯录 · 我的（AI 入口移入「我的」页）。
- IM 分两期：一期 = SDK 升级 + 会话列表完善 + 手机端双屏导航 + 群聊管理 + 图片/文件 + 已读回执 + 联系人选择器建会话；二期（后续另排）= 语音、引用回复、撤回、表情回应、@提及、转发/合并转发。

涉及仓库：`we-meet-android`（主体）、`jusi-light-im/sdk/android`（SDK，composite build 引入）、本仓库（文档）。

实现权威参考：web SDK `jusi-light-im/sdk/web/src/{types,rest,client}.ts`；web IM hooks `src/frontend/src/features/im/hooks/*.ts`（事件处理语义照搬）；web `src/features/{contacts,calendar}`。

## 2. 跨模块衔接决策

1. **ContactPicker 放在新 Gradle 模块 `:core-directory`**，`:app` 与 `:feature-im` 均依赖。`ImDeps` 改为 `interface ImDeps : DirectoryDeps`（`authedOkHttp`/`baseUrl` 签名一致，WeMeetApp 现有实现自动满足）。
2. **通讯录「发消息」直接导航到应用级聊天路由 `im_chat/{cid}`**（IM 改造后聊天页为 AppNav 路由），返回键回到成员详情，对齐飞书行为。
3. **消息 Tab 未读角标**：进程级 `ImSession` 暴露 `totalUnread: StateFlow<Long>`，MainTabScreen 直接 collect。

## 3. 里程碑

### M0 — jusi-light-im Android SDK 升级（对齐 web alpha.7）

`sdk/android/sdk-im/src/main/kotlin/com/jusi/lightim/`：

- `Types.kt`：`ConversationSummary` 增加带默认值字段：`name`、`members`、`owner_uid`、`pinned`、`muted`、`mute_at_all`、`last_message`、`last_message_ts`、`last_sender_uid`、`last_content_type`；新增 `FrameType.CONV`、`ConvOutPayload(event,cid,conv_type,name,members)`、`ReadMarker(uid,seq)`、`ConvMember(uid,role,joined_at,nickname)`。
- `rest/ImService.kt` 新增：`GET /v1/conversations/{cid}/members`、`GET /v1/conversations/{cid}/reads`、`DELETE /v1/conversations/{cid}`（带 body 需 `@HTTP(method="DELETE", hasBody=true)`）、`PATCH .../owner`、`PATCH .../settings`（partial 语义用只装非空字段的 Map）、`POST .../clear`。
- `rest/RestClient.kt`：对应包装，沿用 401-refresh-once。
- `Client.kt`：`conversationEvents: SharedFlow<ConvOutPayload>` + 委托方法；`sendText(cid, body, clientMsgId, contentType)` 已可承载 image/file。
- 版本号 `0.1.0-alpha.7`；补 MockWebServer/分帧测试。

### M1 — `:core-directory` 模块 + 5 Tab 改造

新模块（namespace `com.we.meet.core.directory`）：`DirectoryDeps`、`net/DirectoryNetwork`、`data/DirectoryDtos`（除 id 外全部 nullable/默认值——Moshi 反射）、`data/DirectoryApi`（directory/departments、departments/{id}/members?include_subtree、members?q=&department=、members/{userId}）、`data/DirectoryRepository`、`ui/MemberAvatar`（cache key `avatar:$userId`，禁止用 presigned URL 做 key）、`ui/ContactPicker`。

```kotlin
enum class ContactPickerMode { Single, Multi }
data class PickedMember(val userId: String /* we-meet uuid */, val displayName: String,
                        val email: String?, val avatarUrl: String?)
@Composable fun ContactPicker(deps: DirectoryDeps, mode: ContactPickerMode,
    excludeSelf: Boolean = true, excludeUserIds: Set<String> = emptySet(),
    onConfirm: (List<PickedMember>) -> Unit, onDismiss: () -> Unit)
```

Tab 改造（`MainTabScreen.kt`）：`enum MainTab { Messages, Calendar, Meeting, Contacts, Profile }`，顺序 消息·日历·会议·通讯录·我的，默认选中会议；TabItem 加 badgeCount（99+ 截断红点）；AI Tab 删除，ProfileScreen 加「AI 助手」行 → 新路由 `ai_hub`。AppNav 新路由：`ai_hub`、`member_detail/{userId}`、`event_detail/{eventId}`、`create_event?epochDay={epochDay}`。

### M2/M3 — IM 重构（:feature-im）

- 桥接 API 扩展（对照 web `features/im/api/*`）：`im/users/resolve/`、`im/conversations/group|add-members|remove-member|update|announce-leave/`、`im/{images,files}/upload-url/`、`im/images/resolve/`；direct 增加 `peer_user_id` 变体。
- **ImSession**（进程级单例）：持有 SDK Client/token/selfUid；断线重同步（RECONNECTING→CONNECTED 时刷列表 + onResynced tick）；`totalUnread`；登出 `shutdown()`。
- `ConversationRepository`（排序/事件语义照搬 web `useConversations.ts`；reads 仅 `uid==selfUid` 清未读）、`UserDirectory`（uid→profile 批量缓存，1h TTL）、`MediaResolver`（object_key→presigned URL，50min 缓存）、`ChatUploadRepository`（图片≤1600px WEBP_LOSSY 85 压缩、文件≤50MiB；**presigned PUT 用裸 OkHttpClient，不能走 authedOkHttp**）。
- 消息内容模型：`sealed interface MessageContent { Text/Image/File/Unsupported }` + 单点 parser + `MessageBubble` 单 when 分发——二期每个新类型只加一个子类/分支。
- 导航：删除两栏 `ImTabRoot`，改为 Tab 内 `ConversationListScreen` + 应用级路由 `im_chat/{cid}`、`im_group_info/{cid}`、`im_new_chat`、`im_add_members/{cid}`（聊天页全屏无 Tab 栏）。
- ViewModel：`ConversationListViewModel` / `ChatViewModel`（seq 分页、mid 去重、markRead 仅 RESUMED、已读回执快照+增量、先传后发 pending 项、conv 事件、resync 重拉）/ `GroupInfoViewModel`。
- Coil 缓存：聊天图片 key=objectKey；头像 key=URL 去 query。
- 验收分两批：M2 = 文本 + 列表完善 + 导航切换；M3 = 图片/文件、ReadReceiptSheet、群管理全操作、NewChat/AddMembers。

### M4 — 通讯录（:app/ui/contacts/）

`ContactsTabScreen`（内联搜索 debounce 300ms；面包屑 + 子部门行 + 成员行；`BackHandler` 逐级返回；下钻用 Tab 内本地状态，Tab 栏保持可见）+ `MemberDetailScreen`（路由；发消息 → `POST im/conversations/direct/ {peer_user_id}`（:app 新 `ImBridgeApi`，与 feature-im 的 peer_uid 调用点分开）→ `navigate(im_chat/cid)`）。

### M5 — 日历（:app/ui/calendar/）

视图 = 月历网格 + 选中日 agenda + FAB（API 无日期范围过滤，自绘时间网格性价比低）。

- `CalendarApi`/DTO（全部 nullable/默认值）：GET/POST `calendar-events/`、GET `{id}/`、POST `{id}/rsvp/`；PATCH/DELETE 为 stretch。
- 时区：`OffsetDateTime.parse().toInstant()` → 设备时区显示；**全天事件日期计算用 `event.timezone`**（避免跨时区 ±1 天）；跨天事件展开到每一天。
- `CalendarTabScreen`（翻页拉全量 cap 500；月网格 6×7、事件点≤3、今天按钮；`LifecycleResumeEffect` 刷新）、`CreateEventScreen`（M3 DatePicker + 自包 TimePicker 弹窗；提醒 无/0/5/10/15/30/60/1440 默认10；参与人 ContactPicker(Multi)；全天发独占次日午夜）、`EventDetailScreen`（RSVP SegmentedButton 乐观更新；room_slug 非空显示「加入会议」→ 现有 joinPreview 流程）。

### M6 — 字符串 + 验证

5 locale（values, -de, -fr, -nl, -zh-rCN；zh-rCN 定基调）：:app 新增 tab/contacts/calendar/event 约 43 键；:core-directory picker 约 6 键；:feature-im 约 40 键并删除 raw-uid 弹窗废键。

构建：`./gradlew :app:assembleDebug`（JDK 17）；SDK 测试在 jusi-light-im 仓库 `./gradlew test`。

手工验收（真机×2 或 真机+Web，连 meet.we-meet.online）：
1. **Tab**：5 Tab 顺序/默认会议页/原会议流程无回归；我的→AI 助手→打电话链路；他端发消息时消息角标 +1。
2. **IM**：列表真名/头像/预览/时间；断网恢复重同步；互发文本/图片（>2MiB JPEG 验证压缩、gif）/文件（50MiB+ 拒绝）；300+ 条翻页无重复；直聊已读实时翻转、群 n 人已读与名单一致；建群/加人/踢人/改名/转让/退群/解散实时生效；置顶/免打扰/删除；超 IM token TTL 静默重连。
3. **通讯录**：两级下钻+面包屑+系统返回；搜索防抖；成员详情→发消息→直达聊天页；空部门不崩；头像闲置 10min+ 仍可渲染。
4. **日历**：Web 建事件 App 可见（双端时区一致）；App 建事件带参与人+提醒→Web 可见、参与人可 RSVP；关联会议一键入会；无 room_slug 不显示入会按钮；跨天/全天事件覆盖天都出现。

## 4. 主要风险

- **双仓配对**：SDK 改动经 composite build 即时生效；`ConversationSummary` 新字段全带默认值保持 App 源兼容；两边提交注明配对。
- **presigned URL 三坑**：Coil 稳定 cache key；PUT 不走 authedOkHttp；URL 不持久化。
- **Moshi 反射**：新 DTO 除 id 外全部 nullable/默认值。
- **重连补偿是必需品**：WS 断档消息不会自动补，ImSession resync（列表刷新+最新页重拉+reads 快照）必须做。
- `/calendar-events/` 无日期范围过滤（客户端 cap 500），后端加 `?start=&end=` 为后续事项。
