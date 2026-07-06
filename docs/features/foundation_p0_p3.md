# 基础功能补全 P0–P3 — 设计文档(非 AI 线)

状态:设计待拍板(先评审,拍板再开干)
背景:AI 线(含 `meeting_summary_closure.md`)暂缓,优先补齐基础功能差距。
调研依据:`docs/research/competitor-gap-feishu-wecom-dingtalk-2026-07.md` §四/§五
原则:只扩展不修改;涉及 jusi-light-im 的部分只列需求与接口约定,其服务端实现须按惯例在 jusi-light-im 仓库先出 `docs/phases/pN-*.md` 再开干。

优先级总览:

| 级 | 内容 | 为什么 |
|---|---|---|
| P0 | 移动端离线推送(个推) | 收不到消息的 IM 没有留存可言,卸载级硬伤 |
| P1 | 消息全文搜索 | 全局搜索唯一的功能空洞;后续一切搜索演进的数据前提 |
| P2 | 日历补全:重复日程 + 忙闲视图 | SMB 约会议高频刚需;字段早已占位 |
| P3 | IM 体验打磨:撤回/表情回应服务端化、稍后处理、Pin、残留清理 | 多端一致性风险消除 + 飞书标志性 UX 对齐 |

---

## P0 移动端离线推送(个推 Getui)

### 既定约束
- FCM 搁置(国内不可用)、HMS 不接(工程成本否决)——**个推走保活路径**为既定决议。
- 华为设备不配置个推的 HMS 厂商通道,依赖个推自有通道 + 保活;小米/OPPO/vivo 等厂商通道由个推统一接入(各厂商开发者凭证需申请,见开放问题 Q1)。

### 组件设计

**Android(we-meet-android)**
- 集成个推 SDK(SDK 网络自管,不经主 OkHttp——规避 `AuthInterceptor` 无差别覆盖 Authorization 头的坑,token 上报走我们自己的 API)。
- 启动/登录后取 cid 上报;登出时注销。
- 通知点击 deep link:`wemeet://im/{cid}`、`wemeet://calendar/{event_id}`、`wemeet://room/{room_id}`,落入现有 `AppNav` 路由。
- 合规:隐私政策补个推 SDK 声明与厂商通道清单。

**后端(we-meet Django)— 全部纯新增**
- 模型 `DevicePushToken`:`user FK / provider("getui") / cid / device_id / platform / app_version / last_seen_at`,`unique(provider, cid)`;同 device_id 换 cid 时覆盖。
- 端点(挂现有移动端 JWT 认证,参照 `core/api/mobile_auth.py` 风格):
  - `POST /api/v1.0/push/tokens/`(注册/心跳)
  - `DELETE /api/v1.0/push/tokens/`(登出注销)
- 服务 `core/services/push.py`:个推 REST API v2(appId/appKey/masterSecret 进 settings/环境变量),单推 + 批量,失败仅告警不重试(courtesy nudge 语义,与纪要推 IM 一致)。

**触发源(三个,分期接入)**
1. **日历提醒**(M1,纯 we-meet 侧):`core/services/calendar_reminders.py` 的 `_push_one` 在推 IM 之外追加离线推送(新增方法,不改现有函数);幂等沿用 `reminder_pushed_at`。
2. **IM 离线消息**(M2,依赖 jusi):jusi-light-im 投递时发现接收方无活跃连接 → 回调 we-meet 内部端点 `POST /api/agent/push-hook/`(HMAC 内部鉴权,参照 `core/api/agent_internal.py` 的 X-Agent-Token 模式)→ Django 查 token 发个推。
   - 节流:同一 (user, cid) 在 N 秒窗口内聚合为一条「你有 x 条新消息」;@提及 与 DING 级消息(如未来有)绕过聚合。
   - 正文脱敏开关:默认「{发送者}: {摘要}」,可配置为仅「你有新消息」。
   - ⚠️ jusi 回调里带的是 jusi uid,Django 侧需要反向映射 uid→user(现有 provisioning 已存映射)。
3. **会议事件**(M3):被邀入会/会议开始等,复用同一 PushService。

### 验收与分期
- M1:token 注册 + 日历提醒离线可达(杀进程后仍收到)。
- M2:IM 离线消息推送 + 聚合节流 + deep link 直达会话(jusi 侧先出 pN 设计)。
- M3:会议事件 + 通知设置(免打扰时段,存 we-meet 侧用户偏好)。
- 端到端验收:A 给 B 发消息,B 杀进程 → B 锁屏收到通知 → 点击直达该会话。

---

## P1 消息全文搜索

### 分工
**jusi-light-im(需先出 pN 设计文档,此处仅需求约定)**
- 端点:`GET /search/messages?q=&cid=&limit=&cursor=`(admin HMAC + 以 uid 为主体)。
- 范围:仅该 uid 为成员的会话;已撤回/已删除(含服务端 delete)消息必须排除。
- 中文检索:允许 n-gram/trigram 方案起步(SQLite FTS5 或等价),不强求分词器;返回命中片段偏移用于高亮。
- 排序:时间倒序起步,相关度后置。

**we-meet 后端**
- `ImViewSet` 新增 action `GET /api/v1.0/im/search/?q=`,代理 jusi 端点。
- ⚠️ 调用前 resolve sub→jusi uid(裸 sub 撞 FK 报 500);结果中的对端实体按组织过滤解析(跨组织解析不到是数据边界,非 bug)。

**Web 前端**
- `layout/GlobalSearch.tsx`:补「消息」标签(现 L117-119 注释预留位),结果项 = 会话名 + 发送者 + 高亮片段 + 时间。
- 点击跳转:进入会话并定位到该消息 → `ChatPane` 需支持「按 seq 打开加载窗口」(当前从最新往前拉);这是本功能最大的前端改造点,单独排期。

**Android**:Messages tab 顶部搜索入口,复用 bridge 与同一端点(M3)。

### 分期
- M1:jusi 端点 + Web「消息」标签(点击先只进会话不定位)。
- M2:ChatPane 按 seq 定位加载 + 高亮闪烁。
- M3:Android 入口。

---

## P2 日历补全:重复日程 + 忙闲视图

### D1 重复日程(RRULE 展开)

**现状**:`CalendarEvent.recurrence`(RRULE 字符串)与 `recurrence_parent` 字段、`calevent_start_idx` 索引均已在库(`models.py` L2062-2075),注释明确 MVP 未展开。

**方案:窗口物化(materialize),不做虚拟展开**
- 主事件行存 RRULE;定时任务(与 `push_due_reminders` 同一 beat 周期挂新任务)把未来 N 天(默认 60)内的发生物化为子事件行:`recurrence_parent=主事件`,复制 title/attendees/reminders/room 关联。
- 幂等:`unique(recurrence_parent, start_at)`(条件唯一索引,migration 新增)。
- **收益**:提醒扫描、RSVP、详情、IM 推送、前端 CalendarGrid 渲染——全部现有逻辑零改动,天然逐次生效;完全符合只扩展原则。
- 代价:行数增长(60 天窗口 × 常见 RRULE,量级可控);例外处理见下。

**编辑/删除语义(标准三选)**
- 仅此次:直接改/删该子事件行,并在主事件 `recurrence_exdates`(新 JSONField)记录该次日期,防止重物化。
- 此次及以后:截断主事件 RRULE(UNTIL=该次前一刻),以新主事件承接后续。
- 全部:改主事件,重物化未来窗口(已 RSVP 的未来子事件保留 RSVP 状态,冲突以新时间为准)。

**创建 UI**:`CreateEventDialog` 加重复选项(不重复/每天/每工作日/每周/每月/自定义 RRULE 简表);Android `CreateEventScreen` 同步(M3)。

### D2 忙闲视图(free/busy)

- 端点:`GET /api/v1.0/calendar/freebusy/?attendee_ids=&start=&end=` → 每人 busy 区间列表。
- 数据:该窗口内其 `EventAttendee`(状态非 declined)的事件区间;**只返回 busy 区间,不泄露标题/详情**;private 事件同样只出区间。
- 隔离:attendee_ids 沿用既有组织隔离校验(同 6794c09f 的口径)。
- UI:`CreateEventDialog` 选完与会人后展示横向时间条(每人一行,busy 块着色),冲突时选中时段标红提示但不阻断。

### 分期
- M1:RRULE 物化 + 创建 UI(Web)+「仅此次」删除。
- M2:三选编辑语义完整 + exdates。
- M3:忙闲视图 + Android 重复日程创建。

---

## P3 IM 体验打磨

### D1 撤回/表情回应迁 jusi 服务端原生(一致性债务清偿)
- 现状:两者均为**客户端控制消息约定**(ChatPane L361-453),多端各自聚合——新端(iOS 规划中)每来一个就要重写一遍约定,且历史拉取时序敏感。
- 需求(jusi pN):`POST /messages/{seq}/recall`、`POST /messages/{seq}/reactions`(add/remove),消息行携带 `recalled` 标记与 `reactions` 聚合;推送增量事件。
- 迁移:双读过渡——客户端优先读服务端字段,兼容渲染历史控制消息;双写一个版本后停发控制消息。

### D2 稍后处理(飞书标志性,可完全 we-meet 侧实现,不动 jusi)
- 模型:`ImLaterItem(user, cid, seq, snippet_snapshot, created_at, done_at)`(we-meet 后端,纯新增)。
- 端点:标记/列表/完成;Web 消息右键菜单(`MessageContextMenu`)加「稍后处理」,全局入口挂 IM 侧栏,badge 计数。
- 快照存 snippet 是为了消息被撤回/删除后列表仍可渲染墓碑态。

### D3 Pin 消息(群共享,依赖 jusi)——【2026-07-06 拍板:延后,不入本轮 pN】
- 会话级置顶消息列表,群内成员共见 → 状态必须在 jusi 侧(pN 设计:`POST /conversations/{cid}/pins`,上限 50,权限=群成员,解除=本人或群主)。
- Web:会话头部 Pin 栏 + 列表抽屉;排 D1 之后(复用其服务端改造的发布通道)。
- 延后理由:个人侧价值已由 D2 稍后处理覆盖;等 D1 服务端化落地后再评估。

### D4 残留清理(随手项,可穿插)
- IM 内残留原生 `window.confirm` → styled dialog(既有攒着项)。
- 会话级免打扰/置顶会话:偏好存 we-meet 侧(与 D2 同一批用户偏好表),免打扰同时作用于 P0 离线推送的过滤条件。

### 分期
- M1:D2 稍后处理 + D4 清理(全部 we-meet 侧,无外部依赖,可先行)。✅ 已完成(2026-07-06,commit 37f45032;confirm 残留核实为零)
- M2:D1 服务端化(jusi pN → 双写迁移)。
- ~~M3:D3 Pin~~ 延后(见 D3)。

---

## 跨仓依赖汇总(jusi-light-im 需立项的 pN)

| pN 议题 | 服务 | 被依赖方 |
|---|---|---|
| 离线投递回调(push-hook) | P0-M2 | 离线推送 |
| 消息全文搜索端点 | P1-M1 | 全局搜索 |
| 撤回/回应服务端原生 | P3-M2 | 多端一致性 |
| ~~Pin 列表~~(延后) | ~~P3-M3~~ | IM UX |

前三项立项为 jusi-light-im 的 p14(离线投递回调)/ p15(消息搜索)/ p16(撤回/回应原生化)三个阶段(搜索与离线回调都触碰投递/存储层,建议同期实施)。

## 部署与测试公共项
- 所有 migration 纯新增;生产发布走 `helm upgrade`(只换镜像会漏迁移)。
- 后端测试:先 build app-dev 再 `bin/pytest`;本机注意 15432/9000 端口占用,只起 pg+redis + `--no-deps`。
- Android:改动涉及 SDK 时先清 SDK build 目录再打包(旧路径坑),确认 packageDebug 实际执行。

## 开放问题(拍板项)
1. **P0**:厂商通道凭证(小米/OPPO/vivo)是否本期申请齐,还是先只走个推自有通道+保活验证效果?
2. **P0**:离线推送正文默认带消息摘要还是仅「你有新消息」(涉及通知栏隐私口径)?
3. **P1**:消息搜索结果是否进全局搜索「全部」混排,还是仅独立「消息」标签(建议先独立标签,混排等相关度排序)?
4. **P2**:重复日程物化窗口 60 天是否够(影响「查看明年例会」场景;可配 settings)?
5. **P3**:稍后处理与 Pin 的取舍——若只做一个,建议稍后处理(零 jusi 依赖、个人价值即时)。
