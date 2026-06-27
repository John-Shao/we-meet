# P2 — 日历 / 日程（Calendar / Scheduling）

**状态**：📝 设计待拍板（2026-06-27）。这是 we-meet（非 jusi）阶段——后端 Django + 前端 React,**不涉及 jusi/SDK**(IM 群复用既有 admin bridge)。拍板后再开干。
**工作量**：后端 ~1.5d(模型+API+提醒) + 前端 ~1d + 部署 1 项(定时器)
**前置**：P1 组织架构(通讯录选人/org-scope)、会议核心(Room/ResourceAccess/scheduled_at)、IM bridge(ensure-group / post_message)、会议纪要 IM 推送 pattern
**触发**：路线图第二支柱。当前只有「预约会议」= `Room.scheduled_at`(信息性),没有真正的日程:邀人、RSVP、会前提醒、agenda 视图、与 IM 群联动。

---

## 背景与目标

飞书式日程闭环:**建日程 → 邀人(通讯录)→ RSVP → 自动建会议室 + IM 群 → 会前提醒(IM)→ 一键进会**。

复用面已经很全(P1 + 会议核心 + IM bridge 都在),P2 主要是**新增一个调度实体 + 联动既有能力**,不重写。

---

## 现状（已读代码确认）

| 能力 | 现状 | 文件:行 |
|---|---|---|
| Room = Resource 子类,带 ResourceAccess RBAC | ✅ | `core/models.py:429`(Room)、`:314/:369`(Resource/Access) |
| `Room.scheduled_at`(信息性,UI 用来排"即将开始") | ✅ | `core/models.py:468` |
| BaseModel:UUID id + created/updated + save() 调 full_clean | ✅ | `core/models.py:101` |
| 预约会议前端(按 scheduled_at 过滤 /rooms) | ✅ 客户端过滤 | `features/meetings/components/ScheduledMeetingsList.tsx`、`api/fetchMeeting.ts:87` |
| 会议→IM 群:`POST /rooms/{id}/im/ensure-group`(确定性 cid,幂等,从 ResourceAccess 取成员) | ✅ | `core/api/viewsets.py:1580+`、`MeetingConversation` `models.py:1711` |
| 纪要→IM 推送 pattern(`JusiImAdminClient.post_message` + `summary_pushed_at` 幂等,best-effort) | ✅ | `core/services/meeting_summary.py:192`、`services/jusi_im.py:305` |
| Celery:worker 在跑,`@task` 装饰器带同步兜底 | ✅ | `meet/celery_app.py`、`core/tasks/_task.py` |
| **Celery beat 调度器** | ❌ **没有**(无 beat_schedule、无 celery-beat 服务) | — |
| 通讯录选人 `ContactPicker`(单选 `onSelect(member)`)+ `DirectoryMember` | ✅ 可包多选 | `features/contacts/components/ContactPicker.tsx`、`api/ApiDirectory.ts:15` |
| `User.timezone`(TimeZoneField, zoneinfo) | ✅ | `core/models.py:191` |
| DRF router 注册 + 前端 routes.ts pattern | ✅ | `core/urls.py`、`frontend/src/routes.ts` |
| org-scope 范式(Organization FK + 按 org 过滤) | ✅ P1 已立 | `core/models.py:1798`、`api/directory.py` |

---

## 待拍板决策

| # | 决策 | 倾向（推荐） |
|---|---|---|
| **D1** | 调度实体 | 新增 **`CalendarEvent`**(BaseModel),不把日程塞进 Room。日程 ≠ 视频房间(可全天/外部嘉宾/纯日程),且 RSVP/可见性/提醒不该堆在 Room 上。`Room.scheduled_at` 既有「预约会议」轻量路径保留(legacy),agenda 以 CalendarEvent 为准;二者收敛留后续。 |
| **D2** | RBAC / 参与者 | **不**让 CalendarEvent 继承 Resource。用 `organizer` FK(User)+ **`EventAttendee`** 行表参与者/RSVP。可见性靠 `organization` org-scope + organizer/attendee 过滤(MVP:能看到=我是 organizer 或 attendee)。 |
| **D3** | 联动会议室 | 建日程时**同时建 Room**(server 端 `Room.objects.create` + `ResourceAccess(owner=organizer)`),`Room.scheduled_at = event.start_at`,并调既有 `ensure-group` 预建 IM 群。`CalendarEvent.room` FK **SET_NULL**(房间/群比日程长寿)。"一键进会"= 跳该 room。可选:`all_day` 或纯日程不建 Room。 |
| **D4** | RSVP | `EventAttendee.rsvp ∈ {needs_action, accepted, declined, tentative}`;`role ∈ {organizer, required, optional}`;`user` FK(内部)或 `email`(外部,MVP 可只支持内部)。RSVP 端点 `POST /calendar-events/{id}/rsvp {status}`。 |
| **D5** | 提醒投递 | **走 IM 推送**(复用 `_push_summary_to_im` pattern → `_push_reminder_to_im`:`JusiImAdminClient.post_message(cid=event.room 的 MeetingConversation.cid, body)`),幂等用 `EventAttendee.reminder_pushed_at` 或 event 级 `reminder_pushed_at`。**不接 FCM**([[project-fcm-deferred]])。 |
| **D6** | 提醒调度基建 | 倾向 **k8s CronJob 跑 management command**(`python manage.py send_due_reminders`,每 ~5min 扫 `start_at` 在窗口内且未推的),**而非新立 celery-beat**:k8s 已是部署底座、CronJob 自带单实例语义、比 beat + 单实例锁更简单。备选=celery-beat(plan 原拟)。**这条最值得你定**。 |
| **D7** | 周期重复 | MVP **仅单次**。`recurrence`(RRULE 字符串)+ `recurrence_parent` 字段先建好但不展开。周期+例外留后续。 |
| **D8** | Free/busy | MVP **跳过**(或仅本人)。跨人忙闲后续。 |
| **D9** | Agenda 前端 | 新增 `features/calendar`:建日程表单(复用 ContactPicker 多选邀人)、**agenda 列表**(我的日程,按日/即将)、RSVP 操作、详情。Header 加「日历」入口 + `/calendar` 路由。`ScheduledMeetingsList`(legacy 预约会议)暂保留,后续收敛。 |
| **D10** | 时区 | `start_at`/`end_at` 存 UTC(tz-aware);展示按 `user.timezone` 转换。`timezone` 字段存事件原始时区(跨时区显示用)。 |
| **D11** | 多租户 | `CalendarEvent.organization` FK(nullable,默认 org),queryset 一律 org-scope(同 P1 范式)。 |

---

## 数据模型（草案,继承 BaseModel,db_table = meet_*)

**CalendarEvent**:`organization` FK、`organizer` FK(User)、`title`、`description`、`start_at`/`end_at`(DateTimeField)、`timezone`(CharField/TZ)、`all_day`(bool)、`room` FK(Room, SET_NULL)、`status`(confirmed/cancelled)、`visibility`(default/private)、`reminders`(JSON,提前量分钟数组,如 `[10]`)、`reminder_pushed_at`(幂等)、`recurrence`(空=单次)、`recurrence_parent` self-FK。

**EventAttendee**:`event` FK、`user` FK(null)/`email`(外部)、`rsvp`(needs_action/accepted/declined/tentative)、`role`(organizer/required/optional)。约束 unique(event, user)。

---

## 实施清单（we-meet）

### P2-a 模型 + 迁移（additive,不动既有表）
- `core/models.py`:`CalendarEvent` + `EventAttendee` + 两个 Choices(RSVP/role)。
- migration:加表。

### P2-b API（`core/api/calendar.py`,新建;DRF viewset,org-scoped,IsAuthenticated）
- `CalendarEventViewSet` CRUD(queryset:org + 我是 organizer/attendee)。
- 建日程 `perform_create`:建 event → 建 Room(`ResourceAccess` owner=organizer)→ `Room.scheduled_at=start_at` → ensure-group 预建 IM 群 → 写 EventAttendee(organizer + 选中的人)。
- `POST /calendar-events/{id}/rsvp {status}`(更新调用者 EventAttendee.rsvp)。
- `POST /calendar-events/{id}/attendees` / `DELETE …`(organizer 改参与者)。
- `core/urls.py` 注册 `calendar-events`。

### P2-c 提醒（IM 推送 + 定时）
- `core/services/calendar_reminders.py`:`push_due_reminders()` 扫 `start_at ∈ [now, now+窗口]` 且 `reminder_pushed_at IS NULL` 的事件 → 对每个 attendee 推 IM(复用 JusiImAdminClient,经 event.room 的 MeetingConversation.cid)→ 置 `reminder_pushed_at`。best-effort + 幂等。
- `core/management/commands/send_due_reminders.py`:调上面。
- 部署:**k8s CronJob**(每 5min)跑该 command(D6)。
- (备选 celery-beat:`beat_schedule` + celery-beat 服务,若你选 D6 备选。)

### P2-d 前端（`features/calendar`,新建）
- 建日程表单:title/start/end/all_day + 邀人(包 `ContactPicker` 多选 → `attendee_user_ids`)+ 提醒提前量。
- agenda 视图:我的日程(按时间分组,即将高亮),一键进会(跳 room)。
- RSVP 操作(接受/拒绝/待定)。
- Header「日历」入口 + `/calendar` 路由 + 5 语言。

---

## 不在 P2 / 后续

- 周期事件(RRULE)+ 例外;跨人 free/busy;周/月网格视图;CalDAV/Exchange 同步。
- 与「预约会议」(Room.scheduled_at)的完全收敛。
- 会议纪要也落 Doc(那是 P3)。
- FCM/离线推送(提醒完整通道待 [[project-fcm-deferred]] 解除)。

---

## 验收（端到端）

| 动作 | 期望 |
|---|---|
| 建日程,邀 2 人 | event + Room + IM 群自动建;2 人成 EventAttendee(needs_action) |
| 被邀人 RSVP 接受/拒绝 | rsvp 落库,organizer 可见 |
| agenda 视图 | 我的日程按时间显示,即将开始高亮,一键进会跳 room |
| 会前到点(窗口内) | CronJob 扫到 → IM 群收到「🔔 X 即将开始」提醒,只推一次(幂等) |
| 一键进会 | 跳到该日程的 Room |
| 跨时区 | 北京建的日程,另一时区用户看到本地时间 |
