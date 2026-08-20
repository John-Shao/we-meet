# P2 — 日历 / 日程（Calendar / Scheduling）

**状态**：✅ 已实现并持续收敛（更新至 2026-08-20）。后端、Web、Android 已覆盖重复日程、忙闲、来源会话提醒、范围化编辑/取消、组织者转让、创建副本、个人日历共享与三态公开范围，以及全天民用日期和跨设备日历时区。权限模型详见 [P1-8b](./p2b-calendar-visibility-sharing.md)，时间模型详见 [P1-9](./p2c-calendar-all-day-timezone.md)。
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
| **D2** | RBAC / 参与者 | **不**让 CalendarEvent 继承 Resource。用 `organizer` FK(User)+ **`EventAttendee`** 行表参与者/RSVP。读取统一判定为 `NONE / BUSY / DETAILS`：组织者和参与者、个人日历授权+订阅、来源会话成员构成有效路径；任意 event id 不形成权限。完整矩阵见 [P1-8b](./p2b-calendar-visibility-sharing.md)。 |
| **D3** | 联动会议室 | 建日程时**同时建 Room**(server 端 `Room.objects.create` + `ResourceAccess(owner=organizer)`),`Room.scheduled_at = event.start_at`,并调既有 `ensure-group` 预建 IM 群。`CalendarEvent.room` FK **SET_NULL**(房间/群比日程长寿)。"一键进会"= 跳该 room。可选:`all_day` 或纯日程不建 Room。 |
| **D4** | RSVP | `EventAttendee.rsvp ∈ {needs_action, accepted, declined, tentative}`;`role ∈ {organizer, required, optional}`。内部成员与已接受的[P1b 外部联系人](./p1b-external-contacts.md)都使用真实 `user` FK；`email` 仅保留历史数据读取，新写入不再接受。RSVP 端点 `POST /calendar-events/{id}/rsvp {status}`。 |
| **D5** | 提醒投递 | 有来源会话的日程回原会话发送，身份顺序为组织者 → 日程助手 → SYSTEM；无来源日程只在客户端消息列表聚合，不建群、不接设备直推。幂等使用 event 级 `reminder_pushed_at`。 |
| **D6** | 提醒调度基建 | **k8s CronJob 跑 management command**(`python manage.py send_due_reminders`，每分钟扫描到期且未处理的来源会话日程)，**不新立 celery-beat**：k8s 已是部署底座、CronJob 自带单实例语义、比 beat + 单实例锁更简单。 |
| **D7** | 周期重复 | 主事件保存 RRULE，滚动物化 `recurrence_parent` 子场次；子场次继承来源会话并逐场提醒。编辑/删除支持 `one / following / all`，系列参与人和重复规则编辑仍不开放。 |
| **D8** | Free/busy | ✅ 已实现个人日历组织默认权限、点对点授权与显式订阅；`default / public / private` 在基础权限之上决定详情或忙碌投影。跨组织仅允许已接受且未失效的外部联系人，并要求显式授权。 |
| **D9** | Agenda 前端 | 新增 `features/calendar`:建日程表单(复用 ContactPicker 多选邀人)、**agenda 列表**(我的日程,按日/即将)、RSVP 操作、详情。Header 加「日历」入口 + `/calendar` 路由。`ScheduledMeetingsList`(legacy 预约会议)暂保留,后续收敛。 |
| **D10** | 日期与时区 | 定时日程的 `start_at/end_at` 是 UTC 时间点，`timezone` 保存事件原始 IANA 时区；全天日程以半开民用日期 `start_date/end_date` 为事实源，UTC 字段只作兼容锚点。显示时区支持设备自动/账号固定并跨设备同步，不再复用 `User.timezone`。完整规则见 [P1-9](./p2c-calendar-all-day-timezone.md)。 |
| **D11** | 多租户 | `CalendarEvent.organization` FK(nullable,默认 org),queryset 一律 org-scope(同 P1 范式)。 |
| **D12** | 转让日程 | 仅当前组织者可立即转给同组织 active 内部成员；不要求接收确认。单次日程原地换组织者，重复日程无论从父项还是子场次发起都转让整个系列。事件 ID、来源会话、提醒、视频会议、实体会议室和预订保持不变；新组织者获得事件、个人日历和 Room OWNER 权限，原组织者按选项保留为 required/accepted 参与人或完全移除。 |
| **D13** | 创建副本 | Web/App 仅向拥有完整详情的查看者展示入口，并把当前选中的场次作为新建表单模板。标题、描述、地点、附件名、时间/时区、提醒、公开范围和可见参与者角色被预填；复制者成为新组织者，原组织者在不是复制者时转为 required 参与者。新日程固定不重复，不继承实体会议室和来源会话；原事件带视频会议时仍勾选视频会议，但保存后由标准创建接口生成新 Room/会议号。原投影日历可写时沿用，否则落到复制者启用的可写日历。 |

---

## 数据模型（草案,继承 BaseModel,db_table = meet_*)

**CalendarEvent**:`organization` FK、`organizer` FK(User)、`title`、`description`、定时日程时间点 `start_at/end_at`、全天日程半开民用日期 `start_date/end_date`、事件 IANA `timezone`、`all_day`、`room` FK(Room, SET_NULL)、`status`、`visibility`(`default/public/private`)、`reminders`(空或单个 0–2880 分钟整数)、`reminder_pushed_at/outcome`(幂等结果)、`recurrence`(空=单次)、`recurrence_parent` self-FK、不可重绑的 `source_conversation_id`。

**日历偏好**：`CalendarPreference` 以用户一对一保存自动/固定显示时区、每周首日、默认时长/提醒、工作时间和视图范围；`revision` 防止跨设备静默覆盖。`localStorage` / `SharedPreferences` 只是离线缓存。详见 [P1-9](./p2c-calendar-all-day-timezone.md)。

**个人日历共享**：`PersonalCalendar` 记录组织内默认访问级别，`CalendarAccessGrant` 记录点对点覆盖，`CalendarSubscription` 只记录显示偏好；日程动态投影到组织者与未拒绝参与者的个人日历。数据结构、接口和兼容策略见 [P1-8b](./p2b-calendar-visibility-sharing.md)。

**EventAttendee**:`event` FK、`user` FK（内部成员或已接受的真实外部联系人）、历史 `email`（只读兼容）、`rsvp`(needs_action/accepted/declined/tentative)、`role`(organizer/required/optional)。约束 unique(event, user)。新写协议为 `attendee_entries=[{user_id, role}]`；提交 `email` 返回 400。

---

## 实施清单（we-meet）

### P2-a 模型 + 迁移（additive,不动既有表）
- `core/models.py`:`CalendarEvent` + `EventAttendee` + 两个 Choices(RSVP/role)。
- migration:加表。

### P2-b API（`core/api/calendar.py`,新建;DRF viewset,org-scoped,IsAuthenticated）
- `CalendarEventViewSet` CRUD(queryset:org + 我是 organizer/attendee)。
- 建日程 `perform_create`:建 event → 建 Room(`ResourceAccess` owner=organizer)→ `Room.scheduled_at=start_at` → 写 EventAttendee(organizer + 本组织成员/accepted 外部联系人)。来源会话与会议群遵循 P8 的独立语义，不因日程无来源而自动生成提醒群。
- `POST /calendar-events/{id}/rsvp {status}`(更新调用者 EventAttendee.rsvp)。
- `POST /calendar-events/{id}/attendees` / `DELETE …`(organizer 改参与者)。
- `POST /calendar-events/{id}/transfer/ {new_organizer_id, keep_original_organizer}`：仅当前组织者；目标只能是同组织内部成员；重复日程固定整个系列。成功后立即返回更新后的原事件 DTO。
- `core/urls.py` 注册 `calendar-events`。

### P2-c 提醒（IM 推送 + 定时）
- `core/services/calendar_reminders.py`:`push_due_reminders()` 扫两天提前量窗口与开始后 5 分钟宽限内、带 `source_conversation_id` 且 `reminder_pushed_at IS NULL` 的事件 → 回来源会话发送 → 成功或永久拒绝后置幂等位，瞬时失败留待下轮重试。
- `core/management/commands/send_due_reminders.py`:调上面。
- 部署:**k8s CronJob**(默认每分钟)跑该 command(D6)。
- (备选 celery-beat:`beat_schedule` + celery-beat 服务,若你选 D6 备选。)
- 迁移 `0091_calendar_recurrence_source_backfill`:只回填来源为空且父来源非空的子场次；未来触发点保持待发送，已过且未处理的触发点静默置幂等时间且 outcome 留空。

### P2-d 前端（`features/calendar`,新建）
- 建日程表单:title/start/end/all_day + 邀人（`ContactPicker` 合并本组织成员与 accepted 外部联系人 → `attendee_entries`）+ 提醒提前量。
- agenda 视图:我的日程(按时间分组,即将高亮),一键进会(跳 room)。
- RSVP 操作(接受/拒绝/待定)。
- Header「日历」入口 + `/calendar` 路由 + 5 语言。
- Web/App 日程详情「更多」提供「创建副本」；复制过程不写原事件、不调用编辑接口，保存前仍可修改全部新建字段。

---

## 不在 P2 / 后续

- 重复规则编辑、范围化参与人/视频会议、跨时区共同工作时间。
- 与「预约会议」(Room.scheduled_at)的完全收敛。
- 会议纪要也落 Doc(那是 P3)。
- FCM/离线推送(提醒完整通道待 [[project-fcm-deferred]] 解除)。
- 直接输入陌生邮箱邀请不再属于日历能力；外部账号发现、双方确认、信任组织与访客边界统一见 [P1b](./p1b-external-contacts.md)。

---

## 验收（端到端）

| 动作 | 期望 |
|---|---|
| 建日程,邀 2 人 | event + Room + IM 群自动建;2 人成 EventAttendee(needs_action) |
| 被邀人 RSVP 接受/拒绝 | rsvp 落库,organizer 可见 |
| agenda 视图 | 我的日程按时间显示,即将开始高亮,一键进会跳 room |
| 会前到点(窗口内) | CronJob 扫到 → IM 群收到「🔔 X 即将开始」提醒,只推一次(幂等) |
| 一键进会 | 跳到该日程的 Room |
| 跨时区 | 定时日程按查看者有效显示时区换算；全天日程在所有时区保持相同民用日期 |
| 转让日程并保留原组织者 | 同一事件/系列改由新组织者管理；会议链接和会议室预订不变；原组织者变为已接受的必选参与人；参会人收到一张组织者变更卡 |
| 转让日程且移除原组织者 | 原组织者失去事件与视频会议权限，且日历中不再显示；新组织者立即可编辑、取消和管理参会人 |
| 从重复日程场次创建副本 | 新建表单按当前场次预填且重复规则为空；保存后得到独立事件 ID 和独立视频会议号，原系列不变 |
| 从只读共享日历创建副本 | 完整详情可复制，但目标自动回退到复制者启用的可写日历；实体会议室与来源会话不继承 |
