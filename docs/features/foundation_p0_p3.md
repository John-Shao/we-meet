# 基础功能补全 P0–P3 — 设计文档(非 AI 线)

状态:P0/P1/P3 全部完成(2026-07-18 收口);P2 日历未开始
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
   - ⚠️ 订正(2026-07-18 盘点):**此直连方案已过时,勿实现**。M2 上线后提醒已被离线链路天然覆盖——`_push_one` 经 jusi admin `POST /admin/messages` 注入的提醒文本,与普通消息走同一条 `MessagePublished`(p14)→ 离线成员 → push-hook → `notify_offline` → 个推链路(admin 注入不在 NonBumpingContentTypes 过滤名单)。再直连个推 = 同一提醒**双推**。M1 的增量收敛为零代码,仅验证链路。
2. **IM 离线消息**(M2,依赖 jusi):jusi-light-im 投递时发现接收方无活跃连接 → 回调 we-meet 内部端点 `POST /api/agent/push-hook/`(HMAC 内部鉴权,参照 `core/api/agent_internal.py` 的 X-Agent-Token 模式)→ Django 查 token 发个推。
   - 节流:同一 (user, cid) 在 N 秒窗口内聚合为一条「你有 x 条新消息」;@提及 与 DING 级消息(如未来有)绕过聚合。
   - 正文脱敏开关:默认「{发送者}: {摘要}」,可配置为仅「你有新消息」。
   - ⚠️ jusi 回调里带的是 jusi uid,Django 侧需要反向映射 uid→user(现有 provisioning 已存映射)。
3. **会议事件**(M3):被邀入会/会议开始等,复用同一 PushService。

### 验收与分期
- M1:token 注册 + 日历提醒离线可达(杀进程后仍收到)。✅ 已完成(2026-07-18 盘点确认:零代码——token 注册随 M2 上线;提醒经 jusi admin 注入即触发 p14 离线推送,与 IM 消息同链路,见上方触发源 1 订正。链路各环核实:prod reminders CronJob enabled */5、admin post 调 MessagePublished、text 不被过滤、cid 为 UUID 深链安全)
- M2:IM 离线消息推送 + 聚合节流 + deep link 直达会话(jusi 侧先出 pN 设计)。✅ 已完成(jusi p14 + 个推通知路径真机实测通过;三坑见 §排障)
- M3:会议事件 + 通知设置(免打扰时段,存 we-meet 侧用户偏好)。✅ 已完成(会议事件:「被邀入会」随 P4/p19 走 notify_call 上线,会议开始提醒即日历提醒链路。免打扰时段 2026-07-18 上线:`PushPreference`(OneToOne,墙上钟按 `User.timezone` 解释,跨午夜合法,start==end=全天)+ `GET/PUT push/preferences/` + `notify_offline` 发送前过滤;**来电有意穿透**(实时呼叫错过成本高,飞书「电话穿透」同款默认);App 设置页「消息免打扰」开关+起止时间。含迁移 0057,部署需 migrate)
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
- M1:jusi 端点 + Web「消息」标签(点击先只进会话不定位)。✅ 已完成(jusi p15 + commit 167ad26d)
- M2:ChatPane 按 seq 定位加载 + 高亮闪烁。✅ 已完成(2026-07-17,commit 47ea7504;`?seq&t` 深链 + beforeSeq=seq+11 开窗 + 双向翻页 + 锚点黄底渐隐 +「跳至最新」;稍后处理跳转同路径)
- M3:Android 入口。✅ 已完成(2026-07-18,android commit bbd3c97;全局搜索页=会话本地过滤+消息服务端检索双分区,命中进会话按 seq 回翻定位[200/页×5 页上限]+高亮 2.5s;原会话列表内本地过滤下线)

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
- M1:RRULE 物化 + 创建 UI(Web)+「仅此次」删除。✅ 已完成(2026-07-18:`calendar_recurrence.materialize_recurrences` 60 天窗口、墙上钟按事件时区展开、单主事件单轮上限 120;挂 `send_due_reminders` 同一 beat 先物化后扫提醒,零新增 CronJob;幂等=先查后建+条件唯一索引 `calevent_parent_start_uniq`+exdates;迁移 0058。删除语义:子场次=仅此次(exdate 记 ISO-UTC),主事件=删系列含未来场次。Web:创建对话框预设 不重复/每天/每工作日/每周/每月+截止日(UNTIL 用浮动本地时刻,无 Z——dateutil naive dtstart 下拒绝 UTC 形式),详情弹窗重复标识,删除确认三分文案。**M1 边界**:编辑主事件不回写已物化的未来场次(新物化场次用新值),完整语义待 M2 三选)
- M2:三选编辑语义完整 + exdates。✅ 已完成(2026-07-18:PATCH 带 `edit_scope`=one|following|all,DELETE 带 `?scope=following`。one=改子行+主事件记原时刻 exdate(改时刻也不复活原槽位,撞唯一索引报 400);following=系列分裂——老主事件 UNTIL 截断到分界前一秒(COUNT 移除),新主事件带编辑值接管、COUNT 扣已流逝场次、exdates 按分界分家随 delta 平移、名册复制即时物化;all=标量传播全系列+时间按该场次新旧差平移(主事件 dtstart/exdates/未来子行同步平移),未来窗口重物化、RSVP 按平移映射保留,历史场次只跟标量不动时刻。Web:重复子场次的编辑/删除先弹三选(EditScopeDialog,弹窗即确认)。**M2 边界**:主事件行即系列首场,首场不支持 one/following(等价 all);改 RRULE 本身不在三选内)
- M3:忙闲视图 + Android 重复日程创建。✅ 已完成(2026-07-18:`GET /api/v1.0/calendar-events/freebusy/?attendee_ids=&start=&end=`——只出 busy 区间不泄露标题/详情,rsvp=declined 不算忙,重叠区间合并,attendee_ids 组织隔离静默丢弃,窗口上限 31 天(路径挂在 calendar-events 下,与文档原拟 `/calendar/freebusy/` 略异,以实现为准)。Web:CreateEventDialog 选人后内嵌 FreeBusyBar——按所选日 00:00–24:00 每人一行横向时间条,busy 灰块+所选时段覆盖层,冲突人名与时段标红提示**不阻断**;发起人自己也占一行;全天事件无时段不展示。Android:CreateEventScreen 加重复预设下拉(不重复/每天/每工作日/每周/每月)+截止日期,RRULE 组装与 Web 同口径(UNTIL 浮动本地);**M3 边界**:App 端删除子场次走服务端缺省=仅此次,三选 UI 与忙闲条暂不做 App 端)

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

### D3 Pin 消息(群共享,依赖 jusi)——【2026-07-06 更新:立项为 jusi p17,排 p16 之后】
- 会话级置顶消息列表,群内成员共见 → 状态在 jusi 侧。详细设计见 jusi-light-im 仓 `docs/phases/p17-pinned-messages.md`(ws pin 帧 + `GET /v1/conversations/{cid}/pins` 快照列表,上限 50,unpin=本人或群 owner/admin,撤回读取时过滤)。
- Web:会话头部 Pin 栏 + 列表抽屉(infoPanel 模式);跳转定位依赖 P1-M2。

### D4 残留清理(随手项,可穿插)
- IM 内残留原生 `window.confirm` → styled dialog(既有攒着项)。
- 会话级免打扰/置顶会话:偏好存 we-meet 侧(与 D2 同一批用户偏好表),免打扰同时作用于 P0 离线推送的过滤条件。

### 分期
- M1:D2 稍后处理 + D4 清理(全部 we-meet 侧,无外部依赖,可先行)。✅ 已完成(2026-07-06,commit 37f45032;confirm 残留核实为零)
- M2:D1 服务端化(jusi p16)。✅ 已完成(2026-07-18 盘点确认:服务端/双端 SDK/双端客户端均已上线,客户端只写原生+双读兜底,未走双写阶段;详见 jusi 仓 p16 文档实施注记)
- M3:D3 Pin(jusi p17)。✅ 已完成(双端 PinnedBar 已上线;「点条目跳转定位」子项曾因依赖 P1-M2 留白仅展示,2026-07-18 于 P1 收口后补齐——Web 走 ChatPane 锚定,Android 走 locateToSeq 回翻+高亮)

---

## 跨仓依赖汇总(jusi-light-im 需立项的 pN)

| pN 议题 | 服务 | 被依赖方 |
|---|---|---|
| 离线投递回调(push-hook) | P0-M2 | 离线推送 |
| 消息全文搜索端点 | P1-M1 | 全局搜索 |
| 撤回/回应服务端原生 | P3-M2 | 多端一致性 |
| Pin 列表 | P3-M3 | IM UX |

四项已立项为 jusi-light-im 的 p14(离线投递回调)/ p15(消息搜索)/ p16(撤回/回应原生化)/ p17(Pin 消息)四个阶段;p14、p15 可并行,p16 在后(p15 的 recalled 排除依赖它),p17 最后(依赖 p16 语义与帧范式)。

## 部署与测试公共项
- 所有 migration 纯新增;生产发布走 `helm upgrade`(只换镜像会漏迁移)。
- 后端测试:先 build app-dev 再 `bin/pytest`;本机注意 15432/9000 端口占用,只起 pg+redis + `--no-deps`。
- Android:改动涉及 SDK 时先清 SDK build 目录再打包(旧路径坑),确认 packageDebug 实际执行。

## P0 离线推送上线接线(已落地)

推送链路:**jusi-light-im 检测会话全员离线 → 打签名 webhook 给 we-meet 后端 `/api/agent/push-hook/` → 后端经个推「通知」下发设备**。两侧共享同一个 webhook HMAC 密钥,必须逐字符一致。

### 个推通知 payload 三坑(2026-07-07 荣耀 HONOR 300 实测,`core/services/push_send.py`)

个推返回 `successed_*` 只代表**个推侧受理**,端侧弹不弹取决于 payload,三个字段缺一不显示:

1. **发「通知(notification)」不发「透传(transmission)」**:透传只回调 `onReceiveMessageData` 需 App 存活;冷杀收不到。
2. **notification 必带 `channel_id`/`channel_name`/`channel_level`**(Android 8+ 强制渠道):缺则 `successed` 但静默丢弃。用 `channel_level=4`,id 对齐 App 侧 `im_messages`。
3. **`click_type=intent` 必带显式 `component=com.we.meet/com.we.meet.MainActivity`**:隐式 intent 建 PendingIntent 失败又是静默丢弃;`startapp` 也能弹但丢深链。深链 `intent://im?cid=<会话id>#Intent;scheme=wemeet;launchFlags=0x10020000;component=com.we.meet/com.we.meet.MainActivity;end` → `MainActivity.handleDeepLink` 直达会话。

排障:个推后台「推送记录」各 tab **不统计单推**(single/cid),「暂无数据」是正常口径,别当判据;唯一判据是 API 返回体的 `data.<taskid>.<cid>` 状态 + 真机观察。厂商通道(荣耀/小米/OPPO/vivo)因自有通道已能投达而推迟为可靠性增强,非阻塞。

### 配置落点

| 变量 | 位置 | 性质 | 值 |
|---|---|---|---|
| `PUSH_WEBHOOK_URL` | jusi `deploy/k3s/.../values.prod.yaml`(config→ConfigMap) | 非机密 | `https://meet.we-meet.online/api/agent/push-hook/` |
| `PUSH_WEBHOOK_SECRET` | jusi `secret:` 块空占位 + `secret.yaml` 模板;`06-deploy-jusi.sh` 从 ECS `/etc/jusi-secrets/PUSH_WEBHOOK_SECRET` 软读并 `--set` 注入 | **机密** | `openssl rand -hex 32` |
| `IM_PUSH_WEBHOOK_SECRET` | we-meet `values.secrets.yaml`(**gitignored**,backend.envVars) | **机密** | **= jusi 的 `PUSH_WEBHOOK_SECRET`** |
| `GETUI_APP_ID/APP_KEY/MASTER_SECRET` | we-meet `values.secrets.yaml` | **机密**(MasterSecret 仅此一处) | 个推控制台凭证 |
| `PUSH_CONTENT_VISIBLE` | we-meet `values.meet.yaml`(committed) | 非机密开关 | `True`=带发件人+正文预览 / `False`=仅「你有新消息」 |

`.dist` 模板与 `.env.example` 只放占位符,**真实机密严禁入库**(webhook secret 曾误入 jusi `.env.example`,已清)。

### ECS 手动步(仓库放不了,和 `ADMIN_HMAC_SECRET` 同套路)

jusi ECS(im.we-meet.online / 腾讯云 `159.75.95.21`)上落 webhook 密钥文件:
```bash
echo -n '<与 we-meet IM_PUSH_WEBHOOK_SECRET 同值>' \
  | sudo tee /etc/jusi-secrets/PUSH_WEBHOOK_SECRET >/dev/null
sudo chmod 600 /etc/jusi-secrets/PUSH_WEBHOOK_SECRET
```
缺此文件而 `PUSH_WEBHOOK_URL` 已设时,jusi 启动校验 fail-fast(secret<32)。

### Step-by-step 部署方案

涉及两台 ECS,**顺序不可换**(先被依赖方后依赖方):jusi(im.we-meet.online / 腾讯云 `159.75.95.21`)→ we-meet(aliyun-sjy,后端+前端在同一 K3s)→ APK。命令引用各仓既有部署脚本,不手搓 helm flag。

#### 前置(一次性,只在首次上推送时做)

- **[S0-a] 生成共享密钥**(任一台执行一次,值两侧通用):
  ```bash
  openssl rand -hex 32     # 记为 $WEBHOOK  —— 已用 4805a70c…f5f8
  ```
- **[S0-b] jusi ECS 落密钥文件**(SSH 到 `159.75.95.21`):
  ```bash
  echo -n '<$PUSH_WEBHOOK_SECRET>' | sudo tee /etc/jusi-secrets/PUSH_WEBHOOK_SECRET >/dev/null
  sudo chmod 600 /etc/jusi-secrets/PUSH_WEBHOOK_SECRET
  ```
- **[S0-c] we-meet ECS 填 secrets**(SSH 到 aliyun-sjy,`/opt/we-meet`):
  ⚠️ **`values.secrets.yaml` 是 gitignored 的,`git pull` 不会同步它——开发机上的
  改动到不了 ECS,必须直接在 ECS 本地编辑这份文件**(否则 helm 渲染出的后端 env 缺
  这几个 key,`push-hook` 静默 fail-closed 404,而 `PUSH_CONTENT_VISIBLE` 这种来自
  已提交 `values.meet.yaml` 的键却正常,极易误判为已生效)。在 `backend.envVars` 段
  (与 `JUSI_IM_ADMIN_HMAC_SECRET` 并列,4 空格缩进)补:
  ```yaml
      IM_PUSH_WEBHOOK_SECRET: <$WEBHOOK>        # 与 S0-a / jusi PUSH_WEBHOOK_SECRET 同值
      GETUI_APP_ID: "<appId>"
      GETUI_APP_KEY: "<appKey>"
      GETUI_MASTER_SECRET: "<masterSecret>"     # 仅服务端,严禁进 APK/前端
  ```
  改完必须重跑阶段二的 helm upgrade 才生效,并用 `printenv` 复验这 4 个 key 都在
  (只见 `PUSH_CONTENT_VISIBLE` = 机密没进,回来补这步)。

#### 阶段一 · jusi-light-im(纯增量,先上不影响老客户端)

- **[S1-a]** SSH 到 jusi ECS,拉代码:`cd /opt/jusi-light-im && git pull origin main`。
- **[S1-b]** 构建镜像并导入 k3s:`bash scripts/deploy/06a-build-local.sh`(本地镜像模式),
  或已有 registry 镜像时跳过。
- **[S1-c]** 部署:`sudo -E bash scripts/deploy/06-deploy-jusi.sh`
  (`LOCAL_IMAGE=true` 走本地镜像;脚本自动从 `/etc/jusi-secrets/*` 读 secret 并
  `--set`,tag 默认取 `git rev-parse --short HEAD`)。
- **[S1-d] 验证**:
  ```bash
  kubectl -n jusi rollout status deploy/jusi-light-im --timeout=120s
  kubectl -n jusi exec deploy/jusi-light-im -- printenv | grep -E 'PUSH_WEBHOOK_(URL|SECRET)'
  # URL 应为 https://meet.we-meet.online/api/agent/push-hook/;SECRET 非空且 =$WEBHOOK
  ```
  日志无 `push webhook secret too short` / 启动 panic 即通过。

#### 阶段二 · we-meet 后端+前端(aliyun-sjy)

- **[S2-a]** 本机/CI 构建推送镜像:`bash deploy/aliyun/build-and-push.sh backend frontend`
  (`export IMAGE_TAG=$(git rev-parse --short HEAD)` 走 sha tag;镜像进火山 CR)。
- **[S2-b]** ECS 拉代码+values:`cd /opt/we-meet && git pull origin aliyun-dev`。
- **[S2-c]** 把 `image.tag` 更新到本次 sha(`src/helm/env.d/aliyun-prod/values.meet.yaml`),
  再 helm 升级(带 secrets + common 模板):
  ```bash
  helm -n meet upgrade meet ./src/helm/meet \
    -f src/helm/env.d/common.yaml.gotmpl \
    -f src/helm/env.d/aliyun-prod/values.meet.yaml \
    -f src/helm/env.d/aliyun-prod/values.secrets.yaml --wait --timeout 15m
  ```
- **[S2-d] 迁移(不可跳过)**——helm 只滚 Pod,不会自动 migrate:
  ```bash
  kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input
  kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | tail -6
  # 确认 0054_imlateritem / 0055_devicepushtoken 均 [X]
  ```
- **[S2-e] 验证**:
  ```bash
  kubectl -n meet exec deploy/meet-backend -- printenv \
    | grep -E 'IM_PUSH_WEBHOOK_SECRET|GETUI_APP_ID|GETUI_APP_KEY|PUSH_CONTENT_VISIBLE'
  ```
  **必须 4 行齐**。若只见 `PUSH_CONTENT_VISIBLE`(它来自已提交的 `values.meet.yaml`),
  说明机密没进 → 回 **[S0-c]** 在 ECS 本地补 `values.secrets.yaml` 再重跑 S2-c。
  `IM_PUSH_WEBHOOK_SECRET` 的值应与 jusi pod 里 `PUSH_WEBHOOK_SECRET` 逐字符相同。
  前端(`meet-frontend`)随本次 helm 一并滚,已内置 `@jusi/light-im-sdk@0.1.0-alpha.8`。

#### 阶段三 · Android APK

- 分发 `app/build/outputs/apk/…`;正式包开 `minifyEnabled` 时补
  `-keep class com.igexin.**/com.getui.**`,并在首次进 IM 请求通知运行时权限(Android 13+)。

### 灰度自检(端到端)

1. App 登录 → 后端 `DevicePushToken` 表出现该用户 + cid 行(`provider=getui`)。
2. 用户 A **杀进程离线**,用户 B 发消息给 A。
3. jusi 日志出现 webhook 投递;we-meet 后端 `push-hook` 200,`push_send` 调个推成功。
4. A 通知栏收到(正文由 `PUSH_CONTENT_VISIBLE` 决定)。
5. 点通知 → 深链 `wemeet://im?cid=` 直达对应会话。

任一步断:secret 两侧不一致 → `push-hook` 401/404;cid 无行 → 上报没打通;个推失败 → 检查 GETUI_* 与设备是否注册。

### 回滚

- **jusi**:`helm -n jusi rollback jusi-light-im`(或重跑 06 到旧 tag)。推送是尽力而为、
  发布侧单点触发,回滚不影响收发消息主链路。
- **we-meet**:`helm -n meet rollback meet`。迁移纯新增、无破坏性,**不需要回滚 DB**;
  旧镜像忽略新表即可。

## 开放问题(拍板项)
1. **P0**:厂商通道凭证(小米/OPPO/vivo)是否本期申请齐,还是先只走个推自有通道+保活验证效果?
2. ~~**P0**:离线推送正文默认带消息摘要还是仅「你有新消息」(涉及通知栏隐私口径)?~~ → 已解:`PUSH_CONTENT_VISIBLE` 开关,默认 `True`(带发件人+正文),可切隐私模式。
3. **P1**:消息搜索结果是否进全局搜索「全部」混排,还是仅独立「消息」标签(建议先独立标签,混排等相关度排序)?
4. **P2**:重复日程物化窗口 60 天是否够(影响「查看明年例会」场景;可配 settings)?
5. **P3**:稍后处理与 Pin 的取舍——若只做一个,建议稍后处理(零 jusi 依赖、个人价值即时)。
