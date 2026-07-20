# P8 — IM 会话内日历 / 快速约会 + Android 日历视图补齐（对标飞书）

> 状态:**设计定稿,实施中**。三里程碑:M1 Web → M2 Android → M3 变更推送。
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

**忙闲对比页**:`FreeBusyCompareScreen` + `FreeBusyViewModel`(单聊/群聊共用,群可勾选子集默认前 10 列;freebusy results 缺席的列=跨组织 → 置灰「日历不可见」且不参与判定);点空白 → 1h 选段(±30min 微调)→ 底部确认条(「所有参与者都有空 / N 人忙碌」)→ 预填创建。`CalendarApi/CalendarDtos` +freebusy;`AppNav` +FREE_BUSY 路由(ids/title/srcCid)。

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

## 8. 交付记录

- 第 0 步(顺手修的现网 bug):`perform_update` 未定义 `room` NameError(PATCH 带 attendee_ids 必 500)+ 窗口过滤测试 URL 编码假阴 —— we-meet a9ba0e78。
- M1 / M2 / M3:待交付后回填 commit 号。
- ⚠️ M3 上线必须 helm upgrade 触发 migrate job(0062),`showmigrations core` 验证。
