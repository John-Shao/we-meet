# P9 — 会议室（实体会议室预订，对标飞书）

> 状态:**M1 三端已交付,待实测**(2026-07-25)。后端 `1f04f71b`、Web `8ff8f6a8`、
> Android `9d82948`。上线必须走 `helm upgrade`(带 3 个 migration,只换镜像会漏迁移)。

## 为什么做

日历(P2/P8)有日程、有重复规则、有忙闲、有 RSVP,唯独没有**地点**——`CalendarEvent`
连 `location` 字段都没有。开会订不到房间,楼层里哪间空着也无从看起,运营侧更没有会议
室台账。路线图 `docs/extensions/企业协同套件路线图_对标飞书.md` 里「会议室预订 P2」
一直挂着 ⛔。

M1 补齐的闭环:**运营在 M 端维护「层级树 + 会议室 + 设施」→ 员工建日程时选一间并被
防重订 → 日历页「会议室」Tab 看整层楼的横向时间轴**。

## 命名红线

`Room` / `meet_room` / `/api/v1.0/rooms/` / `features/rooms/` / `CalendarEvent.room` /
Android `room_*` 字符串前缀 —— **全部已被 LiveKit 视频会议房间占用**。实体会议室一律:

| 层 | 用 |
|---|---|
| 模型 / 表 | `MeetingRoom*` / `meet_meeting_room*` |
| 路由 | `/api/v1.0/meeting-rooms/`、`/api/v1.0/admin/meeting-room-*` |
| 事件字段 | `meeting_room`(读)/ `meeting_room_id`(写) |
| Web feature | `src/features/meeting-rooms/` |
| Android strings | `meeting_room_*` |

DTO 定义处都带了「与 LiveKit room 无关」的注释 —— 两个 room 并存,不写注释后来人必混。

## 数据模型（`core/models.py` 末尾 P9 段）

| 模型 | 表 | 说明 |
|---|---|---|
| `MeetingRoomNode` | `meet_meeting_room_node` | 固定四级树（国家/地区→城市→园区→楼栋），保留 `parent` + 物化路径 `path` + `depth`。城市时区必填，其余层级继承城市时区；会议室只能挂在第 4 级楼栋。 |
| `MeetingRoomFacility` | `meet_meeting_room_facility` | 设施字典(电视/投影仪/白板…)。 |
| `MeetingRoom` | `meet_meeting_room` | 会议室本体:楼栋、必填楼层属性、名称、编号、容量、设施 M2M、启停用。 |
| `MeetingRoomBooking` | `meet_meeting_room_booking` | **占用表**,一场次一行。 |

三处刻意的取舍:

**① 设施用字典表,不用 JSON 标签数组。** 飞书截图里有「+ 添加设施类型」,也就是设施
可自定义、可改名、可停用。JSON 数组改个名字要全表扫描重写,还没法做「已停用设施」。

**② 层级不支持 PATCH 改 parent,改父级走 `move` action。** 重挂一个节点要重写整棵子树
的 `path`,`save()` 只维护单节点(与 `Department` 同一约束)。顺带这次把子树重写算法在
会议室这边也实现了一份 —— Department 那边至今仍是「建好就不能挪」。

**③ 占用用独立表,而不是给 `CalendarEvent` 加一个 FK。**
M2 的「维护占用 / 手工占用 / 审批暂扣」都不是日程。一旦拆成两张表,PostgreSQL 就**无法
跨表排斥**,防重订立刻退化成应用层检查。代价是 booking 与 event 的时间可能漂移 —— 用
「写入口单一模块 + 挂钩点全覆盖单测 + 漂移断言测试」来兜。

## 防重订：数据库说了算

```python
ExclusionConstraint(
    name="mrbooking_no_overlap",
    expressions=[("room", RangeOperators.EQUAL),
                 (TsTzRange("start_at", "end_at", RangeBoundary()), RangeOperators.OVERLAPS)],
    condition=Q(status__in=["confirmed", "pending"]),
)
```

- 应用层「先查再插」在两个并发请求下必然重订。EXCLUDE + GiST 是零额外代码、零锁竞争
  的正解;`btree_gist` 扩展单独一支迁移(`0063`)—— 同事务内建扩展再建依赖它的 GiST
  索引,在部分托管 PG 上会失败。权限要求与既有 `pg_trgm`(`0002`)同级。
- `RangeBoundary()` 默认 `[)` 半开区间 → 与 `freebusy` 的 `start_at__lt=end,
  end_at__gt=start` 判据完全一致,10-11 与 11-12 是背靠背而非冲突。
- `condition` 里写字面量而不是引常量:引常量会让 `makemigrations` 反复出 diff。
- `MeetingRoomBooking.save()` 覆写成 `full_clean(validate_constraints=False)`,把失败
  路径收敛成**只有 `IntegrityError`**。否则同一个冲突在无并发时抛 `ValidationError`、
  有并发时抛 `IntegrityError`,调用方必然只 catch 到其中一种。
- 服务层插入必须**嵌套 `transaction.atomic()` 建 savepoint** —— 调用方已在事务里,不建
  savepoint 的话 IntegrityError 会让整个事务 abort,后续任何查询都报
  `current transaction is aborted`。

## 重复日程 × 会议室（本方案最大的风险点）

**方案:每个物化子场次各占一条 booking(1:1 于 `CalendarEvent` 行)。**
`materialize_recurrences` 本来就把子场次物化成真行(`HORIZON_DAYS = 60`),挂钩点唯一。

> **明确语义(前端需照此提示):** 会议室占用只在 60 天物化窗口内被保证。窗口外的场次
> 尚未物化,不占房;等滚动物化到达时才尝试抢占,可能失败。与飞书「超出范围需重新
> 预订」同口径。

写入口收敛在 `core/services/meeting_room_booking.py` —— **全仓禁止别处
`MeetingRoomBooking.objects.create`**。挂钩点 5 处:

| 场景 | 位置 | policy | 行为 |
|---|---|---|---|
| 单次建 / 改 / 换房 / 释放 | `api/calendar.py` `perform_create` / `perform_update` | **strict** | 冲突 → 409 + 冲突区间清单,事务回滚,日程不落库 |
| `scope=this` | `api/calendar.py::update` 子场次分支 | **strict** | 该场次 booking 单独平移 |
| `scope=following` | `services/calendar_recurrence.py::split_series` | skip | **顺序不可颠倒**:先删旧子场次(booking 随 CASCADE 释放)→ 再订新主事件 → 最后物化。反过来新主事件会撞上自己的旧场次 |
| `scope=all` | `services/calendar_recurrence.py::edit_series_all` | skip | 删未来子场次之后、重物化之前 resync 主事件 |
| 滚动物化 | `services/calendar_recurrence.py::_materialize_one` | skip | 循环外取一次系列房间,逐场次抢 |

`skip` 抢不到就落一条 `status=conflict` 的行(不参与排斥),子场次照常生成 —— 会议照开,
只是那一场没订上会议室,前端在该场次打角标。

**为什么系列级用 skip 而单场用 strict:** 系列编辑动辄影响几十场,一场冲突就整体 409 会
让用户彻底改不动自己的周会;而单场编辑用户意图明确,直说订不上才是诚实的答复。

删除路径(`perform_destroy` / `delete_following`)全靠 FK CASCADE,**无需改代码**。

## API

C 端(`IsAuthenticated` + 组织过滤):

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/meeting-room-nodes/` | 层级树,扁平不分页,带 `effective_timezone` / `room_count` |
| GET | `/meeting-room-facilities/` | 设施字典 |
| GET | `/meeting-rooms/` | 分页浏览,`?node=`(含子树)`&q=&capacity_min=&facilities=`(AND) |
| GET | `/meeting-rooms/availability/` | **选择器用**。`start`/`end` 必填,`exclude_event_id`(编辑时剔除自身**及整个系列**),`only_available`。窗口 ≤31 天 |
| GET | `/meeting-rooms/timeline/` | **时间轴用**。`start`+`end` 或 `node`+`date`。窗口 ≤7 天、房间 ≤200 |

管理端(`IsOrgAdmin`):`admin/meeting-room-nodes/`(含 `move`)、`admin/meeting-rooms/`、
`admin/meeting-room-facilities/`、`admin/meeting-room-bookings/`(只读台账)。写操作全部
`record_audit`。

**不开独立的 booking POST** —— 预订完全通过日程字段完成(对标飞书:会议室是日程的一个
字段,不是独立单据),「取消日程 = 释放会议室」天然成立。M2 的维护占用再开。

### 隐私口径

- `availability` **只返回区间,不带标题/组织者**(同 `freebusy`)。选会议室不该成为读别人
  日历的途径。
- `timeline` **始终返回组织者**(姓名+头像)—— 盯着一层楼的排期就是为了找人问那个 2 点的
  块;`title` 仅在事件非 private 或调用者是组织者/参会人时返回,否则 `null` + `is_private`。

### 两个易踩的坑

- `exclude_event_id` 为空时**绝不能**执行 `.exclude(event_id=None)` —— 那会把所有维护占用
  行误杀,而不是「不排除任何东西」。必须 `if exclude_event_id:` 包住。
- 跨组织 / 已停用的 room id 走 **400 而非静默丢弃**(与 `attendee_ids` 不同):会议室是用户
  显式选的,静默丢会让人以为订上了。

## 跨端契约（联调前已冻结）

| 项 | 约定 |
|---|---|
| 清空预订 | `meeting_room_id` 发 `""` 或 `null`,**后端都当释放**。Moshi 不序列化 null,Android 只能发空串;Web 也统一发空串 |
| 字段缺省 | 不动既有预订 |
| 冲突响应 | `409` + `{"detail","code":"meeting_room_unavailable","conflicts":[{room_id,start_at,end_at}]}` |
| 时区 | **M1 时间轴渲染与冲突判定一律按客户端本地时区**;层级时区只用于展示和 `timeline` 的 `node+date` 展开。真跨时区渲染留 M2 |
| 全天日程 | **M1 不支持订会议室**(与忙闲条 `!allDay` 同口径)。「按谁的时区的 00:00–24:00」这个问题还没定,先明说而不是让它悄悄失败。服务端同样 400 |

## 客户端

### Web

- **创建/编辑日程的「添加会议室」区块**插在参与者之后:容量筛选按已选人数起算、可用性
  依赖上方时段、冲突条正好压在提交按钮上方。
- 用**内联展开面板而非嵌套 Modal**:`Modal` 自带焦点陷阱 + Escape,两层会互抢焦点;且
  参与者区本来就是内联搜索 + 内联列表,语言一致。
- 「可用 / 所有会议室」两 tab,后者把该时段被占的房间**置灰不可点** —— 能选中一个必然
  409 的房间是纯挫败感。
- 时段变更**不自动清空**已选(破坏性),只标红并给「换一间 / 取消预订」;可用性查询在
  飞行中时不判冲突,避免提交按钮闪烁误禁用。
- **日历页新增页面级 Tab「日历 / 会议室」**(`?tab=rooms` 刷新保持)。不做成 rbc 的第五个
  view:rbc 自定义视图要接 `{date, events}` 契约,而会议室视图的数据轴是「资源 × 时间」
  而非事件流,筛选栏也塞不进 `components.toolbar`。
- `RoomTimeline`:单一 `overflow-x` 容器包住刻度尺与所有行 + 左列 `position: sticky`,
  **不做 JS 滚动同步**,列头永远不会与网格错位。点空档按 15 分钟吸附建日程。
- `/admin` 新增「会议室」页,沿用部门控制台同一套布局(左树 + 右表格分页 + 弹窗)。
- 纯函数抽到 `utils/` 并配 vitest(32 例):时间↔坐标换算、半开区间冲突判定、树构建。

### Android

M1 **只做选择器 + 详情展示,不做时间轴**:App 的核心场景是「路上快速订一间」;
`ViewModeSwitcher` 已有 4 个分段按钮(每个 `widthIn(min = 52.dp)`),加第五个挤爆窄屏。

- `MeetingRoomPicker` 仿 `ContactPicker`(ModalBottomSheet 0.85f + debounce 300ms + 三态 +
  重试),差异是「可用/全部」分段 + 筛选行 + **单选**(点行即确认,无底部按钮)。
- 放 `:app` 不放 `:core-directory`:后者是围绕 `DirectoryDeps` 自包含的库,不认识
  `ApiClient` / DTO;且唯一消费方就是日程表单。真要复用再抽,届时是纯机械搬迁。
- 时段/房间一变就重查可用性,**网络失败按「不冲突」处理** —— 与其误禁用保存,不如让
  服务端用 409 给准确答复。409 单独映射成「刚被他人订走」而非泛化的保存失败。
- 详情页会议室行放在提醒之后、入会按钮之前:信息归信息、动作归动作;**取消的日程也照常
  展示**,用户仍需知道原本订的是哪间。

## M1.5 — App 端会议室时间轴

选择器 sheet 顶部加一个视图切换图标:列表 ⇄ 时间轴。

**为什么是同一个 sheet 内切换,而不是新开一个页面**:本仓库没有
savedStateHandle 跨屏回传那一套(见 `AppNav.kt`),`CreateEventScreen` 的表单
状态全是普通 `remember` —— 导航走一趟回来,标题/时间/参与者整份丢掉。嵌套
`ModalBottomSheet` 又会两层焦点打架。同 sheet 换个 body 是唯一不牺牲东西的做法。

**方向与 Web 相反是刻意的**:Web 是横向时间 × 纵向房间,App 是纵向时间 ×
横向房间。竖屏天然适合纵向时间轴,也与 App 既有的日/周视图一致;为对齐 Web
掰成横向,反而会和旁边的日历格格不入。

实现上几乎没写新东西 —— `views/TimeGrid.kt` 的 `TimelineScaffold` 已经提供
N 列资源轴、列头与网格共享横滚、24h 格线、`nowMinute` 红线、`selection`
高亮、`disabledColumn` 置灰,新代码只负责把 booking 投影成 `TimeBlock`
(`ui/meetingroom/MeetingRoomTimeline.kt`,约 160 行)。

- 一屏 3 列(窄屏可读),更多会议室横滑
- 该时段被占的会议室整列置灰且点不动 —— 与列表页「不让人选一个必然 409 的
  房间」同一原则
- private 日程只出色块不出标题(服务端已置 null,原样透传)
- **点列 = 选这间会议室,不改时段**:起止时刻上方表单已经定好,从时间轴里
  悄悄改掉它只会让人意外
- 时间轴数据只在切过去时才拉:一天全部会议室的占用比列表重得多

## 测试

后端 101 passed(`test_meeting_room_booking.py` / `test_api_meeting_rooms.py` /
`test_api_admin_meeting_rooms.py` + 扩充的 `test_api_calendar.py`),覆盖:

- `bulk_create` 两条重叠 booking → `IntegrityError`(绕过 `save()` 直击 DB 约束,不用起线程
  就能证明约束真的生效)
- `cancelled` / `conflict` 不参与排斥;`[10,11)` 与 `[11,12)` 可共存、与 `[10:30,11:30)` 冲突
- **并发**:`transaction=True` + 两线程各自 POST,恰好一个 201 一个 409
- 重复日程 strict → 409 且**一个 CalendarEvent 都没建**;skip → 201 且恰好一条 `conflict`
- `split_series` 顺序专项(反序会自撞)
- **漂移断言**:走完「建重复 → all 编辑 → following 分裂 → this 编辑 → following 删除」后,
  所有活跃 booking 的 `(start_at, end_at)` 必须等于其 event 的
- 跨组织隔离、`exclude_event_id` 对整个系列生效、timeline 的 private 脱敏

前端 `npx tsc -b` + `npm test`(48 passed);Android `assembleDebug` 通过。

## M2 / M3 排期

字段已在 M1 一次落齐(避免二次迁移),只是没有业务逻辑:

| 能力 | M1 已留的钩子 | M2 要补 |
|---|---|---|
| 会议室禁用 | `is_active`(M1 已过滤)+ `disabled_reason` | 禁用时对未来预订的处理策略(保留 / 释放并通知组织者)。**禁用原因已可在 M 端填写**(见下节) |
| ~~可预订范围~~ | `booking_scope` + `bookable_departments` M2M | **M2.1 已交付**,见下节 |
| 预订审批 | `requires_approval` + `approval_template`;`PENDING` 已参与排斥(暂扣槽位);`Booking.approval_instance` | 建 booking 时置 PENDING + 提交审批;终态回调改 CONFIRMED / CANCELLED。**M2.1 刻意没做**:开关接出来而不接通审批流,等于给管理员一个不生效的按钮 |
| 维护占用 / 手工占用 | `source` + `event=null` + `title` | `POST /admin/meeting-room-bookings/` |
| ~~时长 / 提前天数限制~~ | `max_booking_minutes` / `advance_booking_days` | **M2.1 已交付**,见下节 |
| 批量导入导出 | — | CSV 模板 + 校验 + 错误行回显 |
| 全天日程订会议室 | — | 先定「按谁的时区」再做 |
| 真跨时区时间轴 | 层级时区已存 | 按会议室层级时区渲染 |
| ~~App 端时间轴~~ | **M1.5 已交付** | 见下节 |

**明确不做:** 签到 / 无人自动释放。飞书后台的「签到二维码 / 投屏盒子 / 飞书传感器 /
设备与运维(定时任务、运维模板、固件升级)」同理不做 —— 那几块依赖飞书自家的会议室
硬件体系,我们没有对应的设备侧。

## M2.1 — 运营台会议室管理对齐飞书

M1 的 M 端只有「左树 + 右表格 + 两个弹窗」,而后端早就支持的能力没有接出来(`?q=`、
`?is_active=`、`description`、`disabled_reason`、设施字典 CRUD 全在,前端一个入口都
没有)。这一轮把它们接上,并顺手落地 M2 表里三行**能在不引入新子系统的前提下真正
生效**的策略。

**列表页**

- 顶部筛选条:搜索(名称 **或**编号)、状态、容量下限、设施多选(AND)。表格换成运营台
  其余页面统一的 Semi `Table`,拿到总数分页与空/载入态 —— 会议室页是最后一个还在
  手写 `<table>` + 「上一页/下一页」的页面。
- 会议室名下压一行完整路径(飞书同款):每层楼都有个 401,只有路径能分辨。
- 左树加搜索框。命中节点**保留其祖先**并自动展开 —— 只留命中行会把层级压成一串
  没有上下文的孤立条目,而层级本身就是这棵树的信息。
- 「设施类型」字典管理弹窗。P9 选字典表而非 JSON 标签数组,图的就是可改名/可停用,
  在此之前却只能进 Django admin 改。

**会议室详情页**(`/admin/meeting-rooms/:roomId`,左锚点导航 + 分区)

做成真路由而不是弹窗:一间房的配置是运营之间会互相甩链接的东西,刷新与前进后退
都得成立。为此给 `MeetingRoomAdminViewSet` 补了 `RetrieveModelMixin`。
分区为 基本信息 / 会议室状态 / 设施信息 / 会议室预定限制;创建弹窗仍只有三个必填
字段,不把每间新房都变成一次策略决策。

**三条真正生效的预订限制**

| 规则 | 落点 | 语义 |
|---|---|---|
| 单次时长上限 | `CalendarEventSerializer.validate` | 超出 → 400。闭区间:正好等于上限可订 |
| 最早可提前天数 | 同上 | 起始时刻超出 `now + N 天` → 400 |
| 可预定范围 | `bookable_scope_filter()`,C 端 `get_queryset` + 预订校验 | `departments` 限定的房间,范围外成员**既看不到也订不了**;命中判据是「用户部门的 `path` 里出现了被授权的部门」,即**授权父部门自动覆盖其下级** |

两个刻意的取舍:

**① 限制校验放 serializer 而不是 `meeting_room_booking` 服务层。** 服务层在重复日程
滚动物化时也会跑,在那里复查「最早可提前」会让 60 天窗口外的每一场都失败,把一个
周会卡死成谁都改不动。限制约束的是**用户此刻提出的请求**,那正是 serializer 看到的
东西。

**② 范围限制没有管理员豁免。** 运营台是改规则的地方,不是坐在规则外面的地方。真要
「会议室预定管理员」那种高权限角色,是独立一档权限模型,不该由 `IsOrgAdmin` 顺带。

顺带修掉的:`?node=` 传非 uuid 会让 `filter(id=...)` 抛 500(现在是空结果);把
`meeting_rooms.py` 里的 `_parse_uuid` / `_facility_ids` 转正为公开函数,管理端复用同
一份解析而不是各写一遍。

## 已知风险

| 风险 | 缓解 |
|---|---|
| booking ↔ event 时间漂移(独立表方案的固有代价) | 写入口单一模块 + 5 个挂钩点全部单测 + 漂移断言测试;M2 可加 `manage.py check_meeting_room_bookings` 巡检 |
| `split_series` 顺序颠倒导致系列撞自己 | 顺序写进服务层注释,专项测试覆盖 |
| savepoint 缺失 → `current transaction is aborted` | `_create` / `_move` 内强制嵌套 `atomic()`;冲突测试在外层事务里触发,天然覆盖 |
| 物化窗口外无占用保证 | 写进本文档与 UI 提示;`HORIZON_DAYS=60` 沿用既有值,不引入新概念 |
| 两个 `room` 命名混淆 | 见上「命名红线」;DTO 旁强制注释 |
| timeline 大窗口打爆响应 | 窗口 ≤7 天、房间 ≤200,超限 400 |
