# P8 — IM 会话内日历 / 快速约会 + Android 日历视图补齐（对标飞书）

> 状态:**已上线,实测通过(2026-07-20)**。三里程碑:M1 Web → M2 Android → M3 变更推送;
> 后续 UX 修正:选择成员/列头对齐(web `4acc747c`+`08c14ed9`,android `82ca460`);
> 日程卡片=组织者气泡+可转发,SYSTEM 变更卡保持居中(web `02479d2a`+`462192a0`,App 端原生已如此)。
> 性质:**只扩展不修改**。日历本体(P2)与 IM 富消息管线(P7)全部复用,不动 jusi-light-im 服务端。

## 1. 背景与需求

对标飞书,支持在私聊/群聊会话中快速查看日历与创建日程:

1. **会话内一键约会**:私聊右上角「查看日历」/ 群聊「群成员日历」,侧边直接展示双方 / 全员忙闲时间轴,拖动空白时段就能新建日程,不切页面。
2. **日程消息互通**:创建完成自动向会话发送日程卡片;改时间 / 增减参会人实时推送变更提醒。
3. **群成员批量排期**:一键查看全员忙闲,自动筛选所有人都有空的时段。
4. **App 端视图补齐**:日历 tab 增加 日程(默认)/日/周 视图(飞书的"三日"我们改为周),月视图保留。

## 2. 现状盘点(全部已核实)

| 能力 | 现状 | 出处 |
|---|---|---|
| 日历模型/CRUD/RSVP/重复/提醒 | ✅ P2 完整 | `core/models.py` CalendarEvent/EventAttendee;`core/api/calendar.py` |
| 忙闲端点 | ✅ 已有 `GET /calendar-events/freebusy/?attendee_ids&start&end`,组织隔离、31 天上限、合并区间、跨组织 id 静默丢弃、不泄露标题 | `calendar.py` freebusy action |
| IM uid → we-meet 用户 | ✅ `im/users/resolve` 返回 `{id(UUID), name, avatar}`;Web `resolveImUsers`、App `ImUserInfo.id`/`GroupMemberUi.userId`/`peerUserId` 均已解析好 | `core/api/im.py` resolve_users |
| IM 自定义消息类型 | ✅ `content_type` 透传(P7),已有 image/quote/file/recall/reaction/call-log/group-call 等先例 | `docs/phases/p7-im-rich-messages.md` |
| 后端向会话发消息 | ✅ jusi admin client + `_post_system_message` 基建 | `core/api/im.py` |
| Web 日历页 | ✅ react-big-calendar,默认周视图,点格建日程;CreateEventDialog 支持 initialStart/End | `features/calendar/` |
| App 日历 | ⚠️ 仅月视图+列表;无时间轴视图、无忙闲对比 | `ui/calendar/` |
| IM 会话内日历入口 | ❌ 双端均无 | — |

## 3. 线上协议:event-card 消息(v1)

`content_type = 'event-card'`(kebab-case,与 call-log/group-call 一致;**双端与后端统一用此值**)。body 为 JSON 字符串:

```jsonc
{
  "v": 1,
  "kind": "created",              // created | time_changed | attendees_changed | cancelled
  "event_id": "uuid",             // 必填;缺失则卡片不可点
  "title": "项目周会",
  "start": "2026-07-21T02:00:00+00:00",   // ISO-8601 UTC,渲染端转本地
  "end":   "2026-07-21T03:00:00+00:00",
  "all_day": false,
  "attendee_count": 5,            // 以后端返回体 attendees 数为准(跨组织 id 会被静默丢弃)
  "organizer_name": "彭伟",
  "old_start": "…", "old_end": "…",       // 仅 time_changed
  "added_count": 2                        // 仅 attendees_changed
}
```

容错约定:JSON 解析失败 → Web 灰气泡「[日程]」/ App 落 Unsupported;`kind` 未知按 created 渲染;时间字段非法只显标题。

**职责边界:created 卡只由客户端创建成功后发;变更/取消卡只由后端发(M3)** —— 天然无双卡。

## 4. M1 — Web 会话日历抽屉 + 日程卡片(后端零改动)

新增:
- `features/im/components/ConversationCalendarPanel.tsx`:右侧抽屉(复用 ImRoute rightPanel 槽位)。日期条 + 纵向时间轴(00-24h,默认滚到 09:00,工作时间外置灰)+ 一人一列忙闲 + 拖/点选(30min 吸附)+ 底部空闲判定 + 群聊建议时段 chips + 内嵌 CreateEventDialog;创建成功 `client.sendText(cid, body, {contentType:'event-card'})`。
- `features/im/components/EventCardMessage.tsx`:卡片气泡(参照 group-call 卡样式)。
- `features/calendar/utils/freeSlots.ts`:共同空闲纯函数(30min 网格 → 全员空闲极大段 → 60min 候选窗(不足降 30min)→ 评分取互不重叠 top3;今天过滤 now+15min 之前;`isRangeFreeForAll` 用原始区间免吸附误差)。
- `features/calendar/components/EventDetailHost.tsx`:按 id 拉取 → 现有 EventDetailDialog;404/403 →「日程已取消或不可见」;organizer 提供「去日历中编辑」(不搬 EditScopeDialog 进 IM)。

小改(全部 additive):fetchCalendar.ts(+fetchCalendarEvent)、calendar/index.ts(barrel 导出跨 feature 入口)、ChatPane.tsx(header 日历按钮 + viewEventId 详情宿主 + snippetOf)、MessageItem.tsx(event-card 分支转发)、ImRoute.tsx(rightPanel 'calendar' 分支 + previewOf「[日程]」)、CreateEventDialog(+initialSelected 初值 prop)。

i18n:`locales/{de,en,fr,nl,zh}/im.json`。

## 5. M2 — Android 视图补齐 + IM 集成

**四视图**:新 `ui/calendar/views/` 包 —— CalendarViewMode(AGENDA 默认)/ViewSwitcherSheet/AgendaView(周分组 sticky「第N周」+当天红线+头尾翻月,不做无限流)/**TimeGrid 可复用四件套**(TimeBlock/HourRail/NowIndicator/TimelineScaffold:Canvas 画格线 + 自定义 Layout 摆块 + verticalScroll)/DayTimelineView/WeekTimelineView(HorizontalPager 翻周)。CalendarViewModel 仅 +viewMode;数据复用 ±1 月窗口。

**忙闲对比页**:`FreeBusyCompareScreen`(单聊/群聊共用;freebusy results 缺席的列=跨组织 → 置灰「日历不可见」且不参与判定);点空白 → 1h 选段(±30min 微调)→ 底部确认条(「所有参与者都有空 / N 人忙碌」)→ 预填创建。`CalendarApi/CalendarDtos` +freebusy;`AppNav` +FREE_BUSY 路由(ids/title/srcCid)。

> **UX 修正(2026-07-20,用户复核飞书截图后)**:① 头像列头在表格内与该列
> 严格对齐(TimelineScaffold 新增 columnHeader/minColumnWidth,列头与网格
> 共享同一横向 ScrollState);② 列宽弹性但有下限(约一屏 4 列),列多时
> **列头 + 网格整体横向滚动**;③ 成员筛选不再用头像行点选 —— 右上角
> 「选择成员」进独立选择页(搜索 + 圆形勾选 + 底部「已选 N 人/确定」),
> **默认全选**、「我」恒选。Web 抽屉同步:右上角选择成员弹窗,列按勾选集
> 过滤(列头/网格本就在同一横滚容器,天然满足 ①②)。

**CreateEvent 预填**:路由参数方案(startSec/endSec/attendeeIds 可选 navArgument,既有调用零变化),屏内 DirectoryApi 补全身份。

**IM 集成**(feature-im 只加回调与渲染分支,接线全在 AppNav,照抄 onOpenInfo 模式):单聊设置页 +「查看日历」行;群设置页新增「群应用」宫格(首期 1 项「群成员日历」);MessageContent +EventCard sealed 子类(**匹配 'event-card'**)+ EventCardBubble + previewText「[日程]」;创建成功 best-effort 回发卡片。

## 6. M3 — 变更推送(后端)

- `CalendarEvent.source_conversation_id`(CharField 64, blank, default "")→ **迁移 0062**;serializer write_only(不回读防 cid 泄露);创建不校验 cid(保持「建日程不依赖 jusi 可达」契约,roster 校验留扩展点)。
- 新 `core/services/calendar_im_notify.py`:on_commit 后重取 event → 组 v1 卡 → jusi admin `post_message(cid, body, 'event-card')` SYSTEM 身份;try/except 仅 warning(best-effort,镜像 _post_system_message)。
- 触发点收敛 `perform_update`/`perform_destroy`(不用 signal:重复日程物化=推送风暴;不进 serializer:拿不到请求语义):save 前快照 start/end + attendee 集合 → 值差分 → `transaction.on_commit`。
- 防噪:改标题/描述/提醒不推;幂等 PATCH 不推;时间+人同变只发一张 time_changed(携 added_count);RSVP 不经此路径天然不推;destroy 用删除前快照推 cancelled。

## 7. 已知限制(设计内)

- 重复日程系列编辑(split/all/following)**不推送**变更卡;物化子场次不复制 source_conversation_id。
- 跨组织会话成员:忙闲列置灰「不可见」,不参与「都有空」判定,不预选为参会人。
- 共同工作时间按浏览器/设备本地时区 09:00-18:00,跨时区团队不在本期。
- 未升级客户端对 event-card 显示 JSON 原文(内部工具,双端同波发版收敛;必要时 M3 可降级发 system 纯文本)。

## 8. 交付记录(2026-07-20)

- 第 0 步(顺手修的现网 bug):`perform_update` 未定义 `room` NameError(PATCH 带 attendee_ids 必 500)+ 窗口过滤测试 URL 编码假阴 —— we-meet `a9ba0e78`。
- M1 Web 会话日历抽屉+日程卡片 —— we-meet `14368971`(tsc -b + eslint 通过;freeSlots 算法 esbuild+node 断言验证,前端无测试基建)。
- M2 Android 四视图+忙闲对比+IM 集成 —— we-meet-android `6fc0b23`(assembleDebug 通过,APK 已出)。
- M3 变更推送 —— we-meet `0e62e5a0` + we-meet-android `f2a40e3`(后端日历全范围 38 测试绿;core 全量套件中 rooms/recording 等 80 个失败为分叉既有,与 P8 无关,已用 HEAD 对照确认)。
- ⚠️ M3 上线必须应用迁移 **0062**(步骤见 §9;只换镜像不迁移会 relation does not exist 500)。

## 9. 部署步骤(阿里云,沿用「latest 标签 + 手动 rollout」模型)

> 通用背景与踩坑详解见 [../extensions/移动端扩展功能部署步骤.md](../extensions/移动端扩展功能部署步骤.md)。
> 拓扑:`aliyun-sjy`(K3s 主节点,meet 全栈)。本次 **Keycloak(aliyun-zlm)、
> jusi-light-im 服务端、summary/agents 镜像、values 均零改动**,不用碰。

### 改动面

| 改动 | 动作 |
|------|------|
| backend(M3 代码 + 迁移 **0062** + 第 0 步 bugfix) | 重建 **backend 镜像** + rollout + **migrate** |
| frontend(M1 会话日历抽屉/日程卡片) | 重建 **frontend 镜像** + rollout |
| Android(M2/M3,we-meet-android `6fc0b23`+`f2a40e3`) | 走既有发包流程出新包 |
| values.meet.yaml / values.secrets.yaml | **无变更**(JUSI_IM_CONFIGURATION 已有,无新 env) |

### 步骤 0 — 推送代码(本机)

两仓 commit 已就绪待手动 push:we-meet(`a9ba0e78`/`14368971`/`0e62e5a0`+docs)、
we-meet-android(`6fc0b23`/`f2a40e3`)。aliyun-sjy 的 `git pull` 依赖远端。

### 步骤 1 — 构建并推送镜像(PC,VPN 开着)

```bash
bash deploy/aliyun/build-and-push.sh backend frontend
```

> ⚠️ 代码改动必须经此步重推镜像;ECS 上 `git pull` 不会更新 registry。

### 步骤 2 — 滚动 + 迁移(aliyun-sjy)

```bash
ssh aliyun-sjy && cd <repo> && git pull

# values/chart 本次无变更,helm upgrade 会是 no-op,可跳;核心是强制滚动:
kubectl -n meet rollout restart deploy/meet-backend deploy/meet-frontend
kubectl -n meet rollout status  deploy/meet-backend  --timeout=5m
kubectl -n meet rollout status  deploy/meet-frontend --timeout=5m

# 迁移(★ 本次关键):从新 backend Pod 手动跑,别指望 helm migrate hook
kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input
kubectl -n meet exec deploy/meet-backend -- \
  python manage.py showmigrations core | tail -3   # 应见 0062_calendarevent_source_conversation_id [X]
```

### 步骤 3 — P8 冒烟(Web,meet.we-meet.online)

1. 私聊 → 头部日历按钮 →「查看日历」抽屉:两列忙闲与日历页色块一致;拖选时段 → 底部判定文案正确。
2. 从抽屉创建日程 → 日历页出现、参会人齐;**会话内出现日程卡片**,会话列表预览「[日程]」;点卡片可 RSVP/入会。
3. 到日历页改该日程时间 → 会话收到「已改期」变更卡(带新旧时间);删除 → 「已取消」卡。改标题 → **不应**有卡片。
4. 群聊「群成员日历」:多列横滚、跨组织成员置灰计数、建议时段 chips 可点。
5. 非会话来源的日程(日历页直接建)改时间 → 无任何推送。

### 步骤 4 — Android 发包

新 APK 已本地构建(`app-debug.apk`);正式内测走既有发包流程(tag → CI → 蒲公英)。
**旧安装包对 event-card 显示 JSON 原文** —— 属已知降级,发包后引导升级即可。

### 回滚

```bash
helm -n meet rollback meet     # 镜像/配置回上一 release
# 迁移回滚(如必要;0062 单列 additive,风险低):
kubectl -n meet exec deploy/meet-backend -- python manage.py migrate core 0061
# 注:回滚后新前端仍会发 source_conversation_id,DRF 对未知字段静默忽略,安全。
```
