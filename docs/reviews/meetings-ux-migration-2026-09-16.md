# 会议模块 UX 收口（2026-09-16）

## 范围

按 [Color System](../color-system.md) D 阶段与 [Foundation System](../foundation-system.md)
的口径，收口「会议」模块的四个栏目页及其共享件：

| 页面     | 路由                                                   | 组件                                                                  |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 视频会议 | `/meeting`                                             | `features/home/routes/Home.tsx`                                       |
| AI 录音  | `/meeting/recording`、`/meeting/recording/history/:id` | `RecordingOverview.tsx`、`RecordingDetail.tsx`、`RecordingUpload.tsx` |
| 会议实录 | `/meeting/notes`、`/meeting/records/:id`               | `MeetingLibrary.tsx`                                                  |
| 智能纪要 | `/meeting/minutes`                                     | 同上（`minutes` 档）                                                  |

共享件：`libraryStyles.ts`、`MeetingNavPanel`、`MeetingModuleNav`、
`ScheduledMeetingsList`、`RecentMeetingsList`、`MeetingDetailPanel`。

不进本次范围：录制工作区（`AudioRecording` / `MeetingRecordWorkspace`）、纪要面板
（`RecordSummaryPanel` 等）与翻译/字幕面板——它们属于「会中/录后处理」工作区，
按业务域各自收口，本次只保证它们引用的共享样式（`libraryLayout`、`moduleRow`、
`moduleContent`）语义与取值不变。

## 改了什么

### 1. 颜色：裸色族 → 语义角色

模块内不再出现 `greyscale.*` / `primary.*` / `white` 这类裸引用：

| 原写法                           | 现在                                                  | 说明                         |
| -------------------------------- | ----------------------------------------------------- | ---------------------------- |
| `greyscale.000` / `greyscale.50` | `surface.default` / `surface.canvas`                  | 卡片、页面底                 |
| `greyscale.100/200` 边框         | `border.subtle`                                       | 分隔线与描边                 |
| `greyscale.600/900`              | `text.secondary` / `text.primary`                     | 正文与辅助信息               |
| `primary.100` + `primary.700`    | `brand.50/100` + `brand.600/700`、`action.selected.*` | 浅蓝底 / 蓝字 / 选中态       |
| `primary.500` 焦点描边           | `border.focus`                                        | 与全站统一焦点环同源         |
| `primary.500` + 白字实心块       | `action.primary.bg` + `action.primary.text`           | 成对使用，深色下自动倒转     |
| `scheduledCard.*`                | 保持不变                                              | 预约会议卡片的既有产品 token |

浅色取值逐项对齐（`brand.N` 的 base 就是 `primary.N`，`text.link` 就是 `primary.700`），
所以浅色是零视觉回归；深色下这批浅底面第一次真正跟着 `_dark` 翻转——此前
`primary.*` 是固定色阶，深色主题里会留一条刺眼的浅蓝亮带。

### 2. 组件：手写控件 → 基元

- 筛选/网格两枚手写方框热区 → `IconToggleButton`，毛玻璃的 hover、pressed、
  focus-visible、`aria-pressed` 一律由基元给出；面板头的齿轮 → `IconButton`
  （原先既无 Tooltip 也无焦点态）；
- 范围筛选那组手写胶囊（含 `data-minutes` 的第二套下划线样式）→ 共享
  `SegmentedControl`：实录用 `appearance="pill"`、纪要阅读器用 `"underline"`，
  方向键与 Home / End 由基元提供；
- 手写搜索框 → `SearchBox`（放大镜 + 清空 + `type="search"`）；
- 原生 `select` 保留，但统一挂 `selectChrome`（32px 钉高、自绘箭头、option 跟随主题）；
- 加载 / 空 / 错误三种状态从各自手写 → `StateHint`（列表与面板）与 `PageState`
  （页面主内容区），live region 语义与重试槽位不再逐页复刻；
- 「进入会议」从手搓 `<button>` + 裸底色 → `Button`，`loading` 同时置 `aria-busy`
  并阻止重复提交。

### 3. 字阶 / 间距 / 圆角 / 高程

- 13 处裸 `fontSize` 与 `fontWeight` 组合换成 Material 字阶
  （`headlineSmall` 页面标题、`titleMedium` 区块标题、`titleSmall` 行标题、
  `bodyMedium`/`bodySmall` 正文与辅助信息、`labelLarge`/`labelMedium` 控件）；
- 数字圆角（`8px` / `0.75rem` / `1rem`）换成 `control` / `card` / `panel` / `pill` / `field`；
- 悬停阴影字面量换成 `shadows.raised`；
- 页内散落的 `1rem` / `1.5rem` / `1.75rem` / `2rem` 边距收敛到
  `space.sm|md|lg|xl|2xl` 语义档，四个栏目页共用同一套页头 / 区块 / 行样式
  （`libraryStyles.ts`）。

### 3.1 页面样板：铺满 + 钉头规则（2026-09-16 追加，已推广到四个栏目页）

以「智能纪要」验收通过的那一版为**样板**，四个栏目页统一到同一套布局、配色、字阶与
列表风格。样板的三条规则：

- **铺满内容列**：去掉 `maxWidth: 1120px` + `margin: 0 auto` 的限宽居中版心（窗口一宽
  两侧就各留一大块空白）。页壳 `pageShell(surface)` 占满内容列，横向内边距用
  `space.lg`（16px，规范里「页面边距」那一档，与任务列表的 `paddingX: 1rem` 同值）。
- **滚动手感：模块内全部钉头**（与任务列表 `TasksRoute` 的 `workspace → main →
header + modeTabs + listRegion` 同一套做法）。页头与工具区（窄屏栏目行、标题、
  范围筛选、搜索、入口块）`flexShrink: 0` 并带 `border.subtle` 底边分隔线，内容区
  `flex: 1; minHeight: 0; overflow: auto` 是页面上**唯一**的滚动区；工作区页把滚动
  让给内部 Tabs 面板，外面用 `contentRegion` 不叠第二层。
  只有一处定义：`pageFixedTop` / `scrollRegion` / `contentRegion`。
  （2026-09-16 之前视频会议页是「整页一起滚」，实机走查发现页头会跟着滚走、标题行
  右侧的三个入口随之消失，已统一成钉头，`wholePageScroll` 随之删除。）
- **页头一行搞定**：页面标题在左，动作组在右（`pageHeaderRow` + `headerActions`），
  动作按钮统一 `Button size="action"` + 18px `icon`。视频会议的「快速会议 / 加入会议 /
  预约会议」三个入口就放在标题行右侧，图标与 App 端取同一套语义 —— Android
  `HomeScreen.kt` 用的是 Material `Bolt` / `AddBox` / `Schedule`，Web 侧对应
  `RiFlashlightLine` / `RiAddBoxLine` / `RiTimeLine`（同符号；字重按 Web 一贯的线性
  图标取 `*Line`，与 Foundation System §1「平台保留各自原生观感」一致）。
- **一套行风格**：行首 48px 品牌浅蓝底图标块（`rowIconTile`，24px 图标）、
  16px/500 行标题（`rowHeadingOneLine` / `rowHeadingClamped`）、12px 次要色辅助信息
  （`rowMetaRow` 横排 / `rowMetaBlock` 竖排）、`lg` 内边距与行间距、浅底悬停、
  内缩焦点环；列表卡 `listCard` + 行分隔线 `listRowDivider`。
  区块标题统一 `sectionHeading`（`titleSmall` + 次要色 + 统一上下间距）。

按样板改过的页面（含 2026-09-16 追加的三个次级页）：

| 页面                                        | 滚动手感                                             | 列表风格                               |
| ------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| 智能纪要 `/meeting/minutes`                 | 钉头                                                 | 样板本体（无边框阅读行）               |
| 会议实录 `/meeting/notes`                   | 钉头                                                 | 网格卡（同一个 `Library` 组件）        |
| AI 录音 `/meeting/recording`                | 钉头（入口块 + 标题固定）                            | 卡内行，已从「裸 24px 图标」换成样板行 |
| 视频会议 `/meeting`                         | 钉头（标题行 + 三个入口固定）                        | 两段卡内行，已换成样板行几何与字阶     |
| 录音详情 `/meeting/recording/history/:id`   | 钉头（返回 + 标题）                                  | 资料卡                                 |
| 会议记录工作区 `/meeting/records/:recordId` | 钉头（返回 + 标题 + 元信息），滚动交给内部 Tabs 面板 | 面板自带                               |
| 录制页 `/meeting/recording/capture`         | 钉头（返回 + 标题）                                  | 表单卡 + 面板                          |

次级页收口带出的两条经验：

- **`pageShell` 必须同时写 `height: 100%` 与 `flex: 1 1 0`**。工作区页直接挂在
  `<Screen>` 下、没有 `MeetingModuleShell`，父级不是 flex 列；只写 flex 时高度由内容
  决定，里面的 `contentRegion` 会塌成 0 高、Tabs 与搜索框变成零尺寸点不动。
  这个回归是被 `scripts/check-meeting-library-ui.mjs`（真实 Chromium）抓到的。
- **工作区页头不能只看 `query.data`**：react-query 重取失败后仍保留上一次的 `data`，
  页头在工作区上方，漏判 `isError` 会让「权限被撤销」时标题继续留在屏幕上。
  现在统一用 `const record = query.isError ? undefined : query.data`。
  这条是 `MeetingRecordWorkspace.test.tsx` 抓到的。

「预约会议」列表卡**已按素卡统一**（原先是 `scheduledCard.*` 蓝调）：与「历史会议」
同一张 `listCard`，行首图标块也换回样板的品牌浅蓝块；随之删掉了 `scheduledCard`
token（`panda.config` 里那组已无任何引用）。区分「预约 / 历史」现在只靠区块标题。

另：搜索框上限的 `maxLength={200}` 在收口 `SearchBox` 时补回（该基元不带此属性，
改在受控值上截断）。

### 3.2 上线后按截图排查出的 UX 问题（2026-09-16 追加，6 条）

拿线上四个栏目页的实机截图逐页走查后修掉的：

| #   | 问题                                                                                                                                            | 处理                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 「预约会议」列表**没有条数上限**：待开始的会议可能十几条，把「历史会议」整段顶出首屏；而「历史会议」自己有 20 条上限 + 「更多」，两段手感不一致 | 默认只预览 10 条，超出时给「查看全部（N）」/「收起」**就地展开**（预约列表没有天然的「更多」目标页）；`home.showAll` / `home.collapse` 是既有 key，未新增文案 |
| 2   | 同一条记录在「AI 录音」与「会议实录」里**版式不同**：前者竖排两行（来源 / 时间），后者横排一行（时间 · 来源）                                   | 统一成单行 `时间 · 来源`（`rowMetaRow`）；顺带把上传处理状态也加到实录行 —— 原先「上传中/失败」只在录音页看得见，而实录才是管理记录的入口                     |
| 3   | 日期解析失败时**把服务端原始值原样画出来**（`return iso`）                                                                                      | 三个格式化函数（预约 / 历史 / 详情面板）都改成先 `Number.isNaN(date.getTime())` 判定，解析不了返回 `null`，那一行元信息整段不渲染                             |
| 4   | 宽屏下**搜索框被拉到近千像素**                                                                                                                  | 搜索框封顶 `28rem`（448px）；铺满版式 + 不限宽时输入起点离内容列左缘太远                                                                                      |
| 5   | 列表主标题是**机器生成的文件名**（`share_68a4…`、`新录音-260915-142621`）                                                                       | Web 端先补上 `title` 提示（省略号截断的长标题悬停可看全）；**根治要后端在导入时给友好默认名 + 提供重命名入口**，属于产品取舍，未擅自改                        |
| 6   | 「我的内容」这件事**两页两套文案**：实录「我的内容 / 共享内容」，纪要「归我所有 / 与我共享」                                                    | 统一到实录那套（zh）：纪要 scope 改为「我的内容 / 我参与的 / 共享内容」。英文本就一致；fr/de/nl 没有这两组 key，回落英文                                      |

第 3 条的**根因后来定死了，见 3.3**：那些行是聊天通话房，`scheduled_at` 本来就是
`null`（不是脏值），只是被当成「待开始的会议」列了出来。Web 侧不再回显原值的改动
仍然保留 —— 它是防御性的，与根因无关。

### 3.3 房间没有自动关闭机制（2026-09-16 追加，根因）

截图里「预约会议」那几行没有时间、名字又是「与W002的通话」「测试2群的视频会议」的，
是**聊天里发起的通话房**。链条：

1. `features/im/call/callController.ts` 发起通话时 `POST /rooms/`，body 只有
   `{ name }`；`RoomSerializer` 也没有默认值 → 房间的 `scheduled_at = NULL`。
   放弃的「快速会议」同理。
2. `video_meetings.overview()` 当时把「没有 session 且未关闭」的房间全列进
   `scheduled`，并 `Coalesce("scheduled_at", "created_at")` 排序 —— 于是这些
   **从来不是预约**的房间被当成「待开始的会议」排在真预约之间，而它们没有时间可显示。
3. 更根本的一层：**房间没有自动关闭机制** —— 没人进过的房间永远停在
   `ended_at IS NULL`，于是这个噪声只增不减（每打一次没人接的通话就多一行）。

两边都修了：

- **预约列表只列真预约**（`core/services/video_meetings.py`）：`scheduled_at` 非空 +
  无 session + 未关闭，按 `scheduled_at` 排序；去掉了 `Coalesce` 注解。**延迟的预约
  照旧保留**（产品明确要求「直到有 session 才离开这一节」），被排除的只有从来就没有
  时间的房间。App 端无需改动 —— 它读的是同一个接口。
- **房间自动关闭**（新任务 `core/tasks/rooms.py::close_abandoned_rooms`）：定时关闭
  「创建后没人进过、也没有预约时间、且超过 `ROOM_ABANDONED_AFTER_SECONDS`（默认
  86400）宽限期」的房间。四个条件同时满足才动，所以**延迟预约永远不会被关掉**
  （关掉等于悄悄取消别人的会），**有人进过的房间也不动**（历史不能丢）。
  注册进 `core/tasks/__init__.py` 与 beat（`close-abandoned-rooms`，每小时一次，
  与既有的 `reconcile-active-meeting-sessions` 同一套写法）。

#### 手动清理（存量）

beat 只清「跑起来之后」的，已经躺在库里的存量要手动跑一次。为此加了管理命令
`core/management/commands/close_abandoned_rooms.py`，条件与定时任务**完全一致**，
并且支持干跑：

```bash
# 生产 K3s 主机上
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl -n meet exec -i deploy/meet-backend -- \
  python manage.py close_abandoned_rooms --dry-run
kubectl -n meet exec -i deploy/meet-backend -- \
  python manage.py close_abandoned_rooms
```

- `--dry-run` 逐行列出**会被关掉**的房间（id / 建房时间 / 名字），一行都不改；
  先看一遍再执行。
- `--seconds N` 覆盖宽限期。默认 86400 秒（一天）；只想清「一天内」的也可以用
  `--seconds 3600` 之类的更短窗口，或 `--seconds 0` 表示「现在就清所有符合条件的」。
- 前提是**本分支的后端已经发上去**（命令随镜像走）。若还没发、又想立刻清线上存量，
  可以在 `manage.py shell` 里跑同一组条件（只用现成的模型关系，不需要新代码）：

```bash
kubectl -n meet exec -i deploy/meet-backend -- python manage.py shell <<'PY'
from datetime import timedelta
from django.utils import timezone
from core import models

cutoff = timezone.now() - timedelta(days=1)
qs = models.Room.objects.filter(
    ended_at__isnull=True, scheduled_at__isnull=True,
    meeting_sessions__isnull=True, created_at__lte=cutoff,
)
print("would close:", qs.count())
for room in qs[:20]:
    print(" ", room.id, room.created_at.isoformat(), room.name)
# 确认无误后取消注释这两行再跑一次：
# print("closed:", qs.update(ended_at=timezone.now()))
PY
```

本地实测（造 5 个样本：两个「无人进过且无预约」、一个刚建、一个有预约时间、
一个有人进过）：

```
$ python manage.py close_abandoned_rooms --dry-run
  4cd5ca5d-…  2026-09-13T16:04:17+00:00  与W002的通话
  f9dd779e-…  2026-09-14T16:04:17+00:00  测试2群的视频会议
[dry-run] 2 room(s) older than 86400s would be closed; nothing changed.

$ python manage.py close_abandoned_rooms
Closed 2 room(s) older than 86400s (cutoff 2026-09-15T16:04:17+00:00).
```

核对：两个该关的 `ended_at` 都写上了；刚建的、有预约时间的、有人进过的三个**都没动**。

### 3.4 区域底色与 App 的页面层级规则对齐（2026-09-17 追加）

线上反馈「固定头部颜色保持不变，列表背景色改为浅色」。先量了实机截图的像素确认现状：

```
页头（钉住）      #F6F6F6   surface.canvas
列表卡            #FFFFFF   surface.default
行分隔线          #E9E9E9   border.subtle
卡片之外那一圈    #F6F6F6   surface.canvas   ← 与页头同色,滚动区不是内容底
```

对照 App 的页面层级规范（`we-meet-android/docs/page-backgrounds.md` §1）：

| 页面层级                                          | 顶部固定区域   | 下方滚动区域   |
| ------------------------------------------------- | -------------- | -------------- |
| 一级：消息 / 日历 / 会议 / 通讯录 / 云文档 / 任务 | 浅灰 `#F6F6F6` | 白 `#FFFFFF`   |
| 二级及更深：新建 / 详情 / 设置 / 搜索             | 白 `#FFFFFF`   | 浅灰 `#F6F6F6` |

视频会议是**一级页**，所以页头保持浅灰（页壳 `surface.canvas` 不动），**列表滚动区改成
白**（`surface.default`）—— 改动只有一处：`Home.tsx` 的 `listRegion` 加
`backgroundColor: 'surface.default'`，页头所在页壳仍是 canvas，于是「浅灰头部 + 白色内容」
两段式成立，与 App 的会议页一致。深色主题由 token 自动翻转。

走查脚本新增断言把这两块底色锁住：页壳必须是 `rgb(246, 246, 246)`（固定头部露出的底色）、
列表滚动区必须是 `rgb(255, 255, 255)`。

### 3.5 四个一级页面统一到「智能纪要」这一版（2026-09-17 追加）

要求是「以智能摘要页面为基准，统一会议模块 4 个一级页面的风格，包括标题、工具按钮、
头部颜色、列表风格」。落地时把基准页的每一处拆成可复用的类，四个页面共用同一份定义：

| 部位     | 统一后的规则                                                                                                | 之前的分歧                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 头部颜色 | 页壳一律 `surface.canvas`（浅灰），只有滚动内容区铺 `surface.default`（白）—— App 一级页规则                | 纪要页整页白壳；AI 录音 / 视频会议的滚动区也是浅灰                       |
| 标题     | `pageTitle`（headlineSmall 24px）+ `pageLead`（次要色说明）                                                 | 视频会议 / AI 录音只有标题，没有说明行                                   |
| 工具按钮 | 页头右侧 `headerActions`，一律 `Button size="action"` + 18px 图标，右对齐                                   | AI 录音是两枚大入口块；「搜索会议 AI」没有图标                           |
| 范围筛选 | `SegmentedControl appearance="underline"`                                                                   | 实录用 pill、纪要用 underline，同为一级页却两种控件                      |
| 列表风格 | `listStack` + `rowSurface`：无边框行、行间距 `md`、悬停一层浅底；行首 48px 品牌块、16px 标题、12px 辅助信息 | 实录 / AI 录音 / 视频会议都是「整块白卡 + 1px 分隔线」，只有纪要是阅读行 |

具体改动：

- `MeetingLibrary`：删掉「卡 / 阅读行」两种形态，`cardShell` 只剩样板行那一份（连带
  `data-minutes` 分支整个去掉）；范围控件统一 underline；「搜索会议 AI」补
  `RiSparklingLine` 图标。
- `RecordingOverview`：页头改成「标题 + 说明 + 两个 action 按钮」，删掉大入口块
  （`RecordingUpload` 的 `tile` 形态随之没有调用点，一并删除）；列表换成 `listStack`。
- `Home`：两个会议列表换成 `listStack`；标题补说明行。
- `libraryStyles`：新增 `contentSurface` / `listStack`，删掉已无引用的 `listCard`、
  `listRowDivider`、`entryTile`、`entryTileRow`。
- 新增两条文案 `library.videoHint` / `library.recordHint`（zh + en；fr/de/nl 回落英文，
  与其它新键一致）。

走查脚本新增 `assertUnifiedPageChrome(label)`，**四个页面逐个跑同一组断言**：页壳
`rgb(246,246,246)`、滚动区 `rgb(255,255,255)`、`main` 里的标题 `24px`、首行
`border-top-width: 0px` 且底色透明；深色主题下滚动区底色必须翻转。

### 3.6 排查：房间为什么没有 meeting session（2026-09-17 追加）

起因：清理那 171 个房间时发现一批（`老酒🥂的会议` 等）**没有 session**。如果那些房
真的开过会，就说明「历史会议」会漏记录 —— 需要定性。

**代码事实（决定了能怎么查）**

- session **只有 LiveKit webhook 会创建**：`core/services/livekit_events.py:254`
  （`room_started`）、`:373`（`participant_joined/left`）；兜底任务
  `core/tasks/meeting_sessions.py:68` 只在 LiveKit 里房间还在时才会补建。
  **没有「发 token / 进房即建 session」的同步路径**，也没有任何独立于 webhook 的
  进房痕迹（`MeetingParticipation`、`MeetingRecord.meeting_session` 都挂在 session 上）。
- 客户端是**先建房、再进房**：Web `Home.tsx` 的 `createRoom()` → `navigateTo('room')`；
  App `PreviewViewModel.createMeeting()` → 摄像头预览页。所以「点了快速会议但没连上」
  （返回 / 关页 / 拒权限 / 网络失败）天然只剩一个空房。
- 生产的 webhook 过滤器 `LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX` 只放行 UUID 房名，
  而房间名就是 UUID ✓ 这条链本身是通的。

**线上数据（近 14 天）**

| 日期      | 建房 | 有过 session | 只建房没开会 |
| --------- | ---- | ------------ | ------------ |
| 9/03–9/09 | 16   | 8            | 8            |
| 9/14      | 21   | 1            | 20           |
| 9/15      | 25   | 2            | 23           |

同窗口：**0 条投影失败**、**0 条僵尸 active session**、3 个房间有 session —— 而且那 3 场
正是用户 9/15 08:10 / 08:48 真正进过的那两间房（1 场 + 2 场）。51 个无 session 的房里
49 个只有 1 个授权人（仅创建者）、没有一个有录音，另 2 个有 4/6 个授权人（带参与人的
日程，没人开始）。

**结论**：记录机制是好的 —— **只要进了房就有 session**；9/14–9/15 那 46 次建房是
「创建后没进房」（75 秒内建 4 个的密集节奏与反复点击/重试吻合），不是漏记。
`close_abandoned_rooms` 已经把这类空房收掉，这条关闭。

**顺带修掉的观测缺口**：生产原本没有 `LOGGING` 配置（root = WARNING），而
「收到 webhook」那条是 `logger.info` —— 于是「webhook 到底有没有投递」在日志里查不到，
这次排查只能靠数据反推。现在 `Production` 只把会议链路的 4 个 logger 开到 INFO
（`livekit_events` / `meeting_sessions` / `tasks.meeting_sessions` / `tasks.rooms`，
内容全是 id，不含姓名/邮箱/token），root 仍是 WARNING，并加了 `LOG_LEVEL` 环境变量
（默认 INFO，需要安静时设 WARNING）。验证：用 Production 配置实际加载，
4 个 logger 均为 INFO 且 `isEnabledFor(INFO)` 为真；`LOG_LEVEL=WARNING` 时为假。

**待定**：那 46 次建房如果是**客户端在重试**（进房失败 → 再点 → 又建一个新房），
值得做一个 UX 改进：已经存在未开始的房间时**复用它**，或提示「你有一个未开始的会议，
继续进入？」。是手动测试点击的话就不用改。

### 3.7 快速会议 / 语音聊天 / 视频会议复用未开始的房间（2026-09-17 追加）

3.6 的结论是那批空房来自「先建房、再进房」但没进成。根治这一层：**同一个入口再点
一次时，复用自己那个还没开始过的同名房间**，不新建、也不弹提示。

三个入口（会议页「快速会议」、聊天里的语音聊天 / 视频会议、App 的「发起会议」和
「快速会议」）打的都是同一个 `POST /api/v1.0/rooms/`，所以改在后端一处，Web 与 App
一起生效 —— **客户端零改动**。

`RoomViewSet.create` 现在先找一遍「可复用房间」，条件是**四条同时成立**：

| 条件                   | 为什么                                              |
| ---------------------- | --------------------------------------------------- |
| 调用者是该房间的 OWNER | 别人的同名房间不能抢                                |
| `scheduled_at` 为空    | 预约会议走日程，不该被「快速会议」顶掉              |
| `ended_at` 为空        | 已结束（或被 `close_abandoned_rooms` 清掉）的不复用 |
| 一场 session 都没有    | 开过会的房间不复用，下一次是真的新会议              |

另外：请求自带 `scheduled_at`（「预约会议」）时一律新建 —— 那是新的一场安排，不能并进
已有的空房。命中时返回 **200 + 已有房间**（而不是 201），让调用方能区分「复用」与
「新建」。

复用与 3.6 的清理是互补的：`close_abandoned_rooms` 收掉已经攒下的，这条不再攒新的。
客户端本来就有的 `loading` 态会挡住连点，所以也不会出现两个请求同时没找到而复用失败的竞态。

前端 `Room.tsx:46` 用 `history.state.create` 决定进房后是「发起人视图」还是「加入视图」；
复用者仍是房主，所以这个标记照旧成立，无需改动。

**验证**：`core/tests/rooms/test_api_rooms_create.py` 新增 6 条用例（复用命中并返回同一个
id/slug、开过会后新建、结束后新建、带 `scheduled_at` 时新建、不抢别人的同名房、不同名
各自建房）全部通过。整个 `core/tests/rooms` 目录在改动前后**失败数一致（31 条，差异为空）**。

### 3.8 顺手修掉 3 条过期的建房断言（2026-09-17 追加）

3.7 那 31 条既有失败里有 3 条是**断言过期**（不是环境问题），已修：

- 会议号早就从「名字的 slugify」改成服务端生成的 8 位数字（`Room.save()` →
  `Room.generate_unique_slug()`，`secrets.randbelow` + 重试 + `zfill(8)`），而
  `test_api_rooms_create_authenticated` / `..._generation_cache` 还在断言
  `room.slug == "my-room"`。现在断言 `\d{8}`；缓存里的 slug 改成与建出来的房间比对。
- `test_api_rooms_create_authenticated_existing_slug` 的前提已经不存在（同名建房不再
  撞 slug），拆成两条更贴近现状的：**同名两个房间各有各的会议号**（会议号与名字无关），
  以及**生成器撞上已占用的号会重试**（monkeypatch `secrets.randbelow` 喂「先返回占用的、
  再返回下一个」）。
  注意：`RoomFactory` 默认用名字的 slugify 生成 slug，与生产不一致，所以那条用例显式
  传了数字 slug。

结果：`core/tests/rooms` 失败数 **31 → 28**，消失的正好是这 3 条、无新增失败。剩下 28 条
是既有的环境问题（缺 S3 / LiveKit 等 compose 依赖）与 `test_api_rooms_retrieve.py` 里
一批**响应结构过期**的断言（`response.json()` 精确比对，多出的字段没跟上）——后者性质
相同，属于下一批可以顺手清的。

### 3.9 会议实录页去掉「上传」「录音」按钮（2026-09-17 追加）

按要求把「会议实录」页头的【上传】【录音】两枚按钮删掉 —— 这一页只查/看，两个动作都归
AI 录音页（页头同款按钮 + 导航里的固定入口），不必同一动作在两个页面各摆一份。

- `MeetingLibrary.tsx`：删掉 `{!minutes && …}` 那一段（连带 `RecordingUpload` 的 import
  与 `capture_audio_enabled` 判断）；实录页头现在只剩「搜索会议 AI」。
- 智能纪要页本来就没有这两个按钮。于是四个页面的页头动作集合是：视频会议 = 三个入口，
  AI 录音 = 导入 + 录音，实录 / 纪要 = 搜索会议 AI —— **样式统一，动作各归其位**
  （3.5 定的那条「同一档 action 尺寸 + 18px 图标、右对齐」继续成立）。
- 走查脚本新增两条断言：实录页上「上传」「录音」按钮计数必须为 0 —— 以后谁加回来直接红。

### 3.10 把 rooms 那 28 条失败清干净（2026-09-17 追加）

接着 3.8 把剩下的 28 条全部定性并修掉，`core/tests/rooms` 现在 **308 passed / 1 skipped
/ 0 failed**。按根因分四类 —— **只有最后一条是真的外部依赖**：

| 根因                                                                                                                                                                                                            | 条数                                                            | 处理                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **响应结构漂移**：`RoomSerializer` 后来加了 `created_at / closed_at / owner / scheduled_at / event_id / is_owner`，`accesses` 里的 user 也多了 `avatar_url / cover_url / intro / phone`，测试仍按旧形状精确比对 | retrieve 13 + participants 1                                    | retrieve 加 `room_payload()` helper（按序列化器构造完整期望值，以后加字段只改一处）；participants 补上 user 的四个字段 |
| **旧行为前提消失**：① 改名连带改 slug（现在会议号只读、改名不改号）；② `assertNumQueries(3/4)` 没算上序列化器为 owner / event_id 多查的两次                                                                     | update 4 + retrieve 2                                           | 断言改成「slug 与改名前的值相等」；查询数改成实测的 6 / 7，并注明多出来的两次是什么                                    |
| **本地化消息**：接口返回中文（`{'detail': '未找到。'}`），测试写死英文                                                                                                                                          | subtitle 4 + start/stop recording 2 + participants 1 + invite 4 | 期望值改用 `gettext(...)`：语言无关，且仍然精确比对                                                                    |
| **被测前提变了**：`participant_joined` 现在有处理器（拿它当「未处理事件」会去解析 `room.name` 而报错），枚举里没有 `_handle_*` 的是 `track_published`                                                           | webhook 1                                                       | 改用 `track_published`                                                                                                 |
| **外部依赖**：邀请邮件模板 `mail/html/invitation.html` 不在本仓库（由 mail 服务提供）                                                                                                                           | invite 1                                                        | 标 `@pytest.mark.skip(reason=…)`；接口行为由同文件另外几条用例覆盖                                                     |

另外删掉一条前提已消失的用例：`test_api_rooms_retrieve_anonymous_private_slug_not_normalized`
依赖「房名 slugify 成会议号，所以非规范化写法也能命中」，而会议号现在是服务端生成的数字，
拿房名去取会落到「未注册房间」分支（`id: null` + 一张临时 LiveKit 凭据）。按会议号取房的
覆盖由 `..._anonymous_private_slug` 与 `..._private_pk_no_dashes` 保留。

### 3.11 列表视图改成表格（对齐飞书，2026-09-17 追加）

参照飞书把「会议实录」「智能纪要」的**列表视图**做成表格（卡片视图一行没动）：

| 列       | 来源         | 说明                                                                        |
| -------- | ------------ | --------------------------------------------------------------------------- |
| 标题     | `title`      | 行首 32px 图标块 + 标题，下面一行是「会议时间 · 来源 · 上传状态」与状态徽标 |
| 所有者   | `owner`      | 序列化器新给的显示名（姓名 → 短名 → 邮箱），取不到显示「未知」              |
| 修改时间 | `updated_at` | 同年只到「月日 时:分」，跨年补年份                                          |
| 创建时间 | `created_at` | **可排序**：表头点击在降序 / 升序之间切换，`aria-sort` 同步                 |

几条实现上的取舍：

- **表头只出现一次**。两段列表（进行中 / 历史记录）是**同一张 `<table>` 的两个
  `<tbody>`**：表头在最上，分组名是表内的行组标题单元格（`<th scope="rowgroup">`，
  读屏读成这一组的表头）。原先是每段一个 `<h2>` 小节，表格里不能再套 `<h2>`
  （`td/th` 不接受标题内容），所以换成行组标题 —— 视觉上仍是那一档小灰字。
- **排序只作用于已加载的这一页**，缺 `created_at` 的排最后，其余相等时保持服务端
  顺序；跨页排序要后端加 ordering 参数，这一次没动接口契约。
- **列宽用 `table-layout: fixed`，只在 md 起**。窄屏（<md）收起后三列与整个表头，
  列表退回「标题 + 一行辅助信息」，所有者并进那一行 —— 手机上没有横向滚动，也就
  没有排序入口（默认顺序 = 服务端顺序）。
- **「会议时间 / 来源」留在副行**。飞书那四列里没有它们，但会议记录的「会议时间」
  （`origin_at`）不是数据库时间戳，删掉就是信息丢失；所以主单元格是两行，行高比原来
  的 48px 图标卡矮一档。
- **翻页游标提到页级**：视图开关只换渲染形态（`<ul>` ↔ `<tbody>`），组件级 state 会
  随根元素换类型而重挂，翻到第 3 页再切视图就会掉回第一页。游标栈现在放在 `Library`
  里，按筛选条件推导（筛选一变回第一页，与原先靠 `key` 重挂组件同一效果）。
- **错误态不残留旧数据**：`isError` 时 react-query 仍留着上一次的 `data`，表格与卡片
  都显式清空行 —— 权限被收回后不能还看得见标题（既有的 vitest 用例抓的就是这条）。

### 3.12 窄屏栏目胶囊行：一次误判与两个真修（2026-09-17 追加）

我在这轮末尾报过一个「390px 下顶部胶囊行折行、挤到第二行」的问题 —— **那条是误判**，
把走查截图里的残留 Tooltip 当成了页面元素：

- 截图里那颗「会议设置」不是入口，是 `MeetingNavPanel` 里齿轮 `IconButton` 的
  Tooltip。react-aria 的 tooltip 是挂在 `body` 下 `data-overlay-container` 里的
  portal：键盘走查 Tab 到齿轮时它弹出来，之后视口缩到 390px，它仍留在**桌面端的
  老坐标**上（实测 `rgb` 位置 x=187,y=53，正是齿轮在 260px 面板里的位置），
  于是看起来就像胶囊行的第 5 项折到了第二行。
- 胶囊行本来就不折行：DOM 实测 `flexWrap: nowrap` + `overflowX: auto`，四个入口
  `top` 全等（同一行），`scrollWidth ≥ clientWidth` 时整行横滑。

两处真修：

- **内边距在窄屏收一档**（`paddingX: { base: 'md', md: 'lg' }`）：16px 内边距时
  四个胶囊合计 360px，390px 视口只有 358px，最后一个「智能纪要」会被切掉 2px
  （375px 机上切 17px），只能靠横滑去够。收到 12px 后 390/375 都能完整显示，
  ≤360 仍是横滑不折行。
- **走查脚本不再留 Tooltip**：截图前显式 `Escape` + `blur`，并等到 portal 里的
  tooltip 真正不可见（退场有淡出动画，等一拍等不干净）才拍；同时加了四条断言锁住
  胶囊行行为 —— 一行、`nowrap`、`overflow-x: auto`、390px 下四个入口完整显示。
  这类「截图里的幽灵元素」以后不会再骗到人。

### 3.13 搜索框搬进页头动作行、去掉「搜索」按钮（2026-09-17 追加）

实录 / 纪要两页原先的固定区有两行工具：上面一行是范围筛选 + 筛选/视图两个图标，
下面一行是「搜索框 + 搜索按钮」。现在搜索框并进页头动作行：

- **搜索框移到「搜索会议 AI」左侧**（同一行、同一档 32px 高），宽屏钉 18rem；
  窄屏放开收缩 —— 390px 下这一行正好是「输入框 + 搜索会议 AI」，不折行、不横向溢出。
- **去掉「搜索」按钮**：提交只剩回车（表单提交）。清空输入仍然立刻撤销关键词筛选，
  行为没变；`SearchBox` 自带的 ✕ 是清空不是提交（基元里早就写了 `type="button"`，
  否则回车与 ✕ 会互相干扰）。
- 文案键 `library.searchButton` 保留 —— 记录工作区的「搜索整份逐字稿」还在用它。

顺带一处结构收口：筛选面板原先挂在搜索表单里（靠 `flexBasis: 100%` 占满一行），
搜索框搬走后表单只剩一个输入、不必再包一层块，面板改为独立落在工具栏下方
（`flexBasis` 换成 `marginBottom`）。功能不变：`筛选` 图标开合、两个原生 select 的
钉高断言照旧。

走查新增四条断言：没有「搜索」按钮、输入框在 AI 按钮左侧且与它同一行、宽屏宽度钉在
18rem 附近、**回车会发出一次带 `q` 的查询请求**（按钮没了以后这是唯一的提交路径，
必须有人守住）。两页各验一遍。

### 3.14 AI 录音页页头动作:换序、主操作、图标（2026-09-17 追加）

按截图提的三条改 AI 录音页页头：

1. **「录音」在前、「导入」在后** —— 与 App 端 `RecordingHomeScreen` 同序
   （录音 ActionCard 在左、导入在右），主操作落在靠左那一颗。
2. **「录音」改用 `variant="primary"`**：与视频会议页的「快速会议」同一档实心按钮
   （`action.primary.bg`）。这一页的主操作是开始录音，之前它和「导入」都是线框次按钮，
   两个动作看起来一样重。
3. **「导入」的图标换成向下的箭头**（`RiUpload2Line` → `RiDownload2Line`）：
   动作是把外部的音视频**收进来**，向上的箭头读起来像要发出去。

走查补三条断言，比"有没有 svg"强一档：

- 「录音」的实测底色必须是 `rgb(40, 96, 217)`（与「快速会议」同一个断言值）；
- 「录音」的左缘在「导入」右侧之前、两者同一行（比坐标，不看截图）；
- 「导入」图标 `path d` **等于现渲染的 `RiDownload2Line`、且不等于 `RiUpload2Line`**
  —— 新增 `iconPath(name)` 辅助函数在真实模块图里渲染一枚图标取 `d`，方向写反这类
  回归只有比路径才守得住。

顺带修掉走查里两处**恒真**的断言：AI 录音页的 `/recording-uploads/` fixture 一直返回
`available: false`，而 `RecordingUpload` 在能力不可用时整块早退 —— 也就是说「导入」按钮
从来没被走查渲染过，之前那句「实录页不该有『上传』按钮」按 `upload.open` 这个**键名**
匹配，无论有没有按钮都是 0。现在 fixture 给可用的一份、断言按键名的中文标签匹配。

### 3.15 视频会议页去掉节标题上方多余的空白（2026-09-17 追加）

「预约会议」「历史会议」两节标题上方各有一大截空白，实测「预约会议」的文字上沿距
固定区下沿 **64px**（滚动区上边距 16 + 节容器 `marginTop` 24 + 节标题自带 `marginTop`
24）—— **节间距被写了两遍**。另外三个栏目页的首个小节标题只有 28px。

规则收成一条：**节间距只由一层负责**。

- `libraryStyles` 增加 `sectionHeadingFlush`（`groupLabel` + `marginBottom`，不带
  `marginTop`）：给「外层容器已经用 `marginTop` 排过节间距」的地方用。
- 视频会议页的两个列表（`ScheduledMeetingsList`、`RecentMeetingsList`，各自的
  `sectionStack` 已经写了 `marginTop: xl`）改用这一档；单节的页面（实录 / 纪要 / 录音）
  继续用 `sectionHeading`，那里标题自带的那一档就是唯一的间距。
- 视频会议页列表区的 `paddingTop` 从 `lg`(16) 收到 `xs`(4)：与另外三个栏目页同档，
  首个小节标题一律落在固定区下沿下方 28px（4 + 24）。节与节之间是 24px。

结果：首节标题 64px → **28px**，第二节 48px → **24px**（实测数字写进走查断言）。

走查新增三条断言（比像素比的是**规则**，以后谁再叠一层会直接红）：两节的 `<h3>`
`marginTop` 必须都是 `0px`、它们的容器必须都是 `24px`、首节文字上沿距固定区下沿
28±2px。

### 3.16 未登录落地页上的死代码（2026-09-17 追加）

问题来自 3.15 的收尾提问：「未登录落地页为什么会用 `ScheduledMeetingsList`？」查下来
是**死代码**，已删。

时间线（`git log -S`）：

- 2026-05-27 `cedddd49`：首页加「最近会议」入口 —— 那时首页对所有人都是这一版。
- 2026-06-02 `efb2e23c`：拆成「预约会议」+「最近会议」两节。
- 2026-07-21 `6f5e5e17` / `b24f9e3f`：列表行点开右侧详情面板、系统设置加「会议设置」。
  这一时期首页仍然是「所有人同一版」，所以落地页那一份列表带 `enabled={!!isLoggedIn}`
  是有意义的（登录过才显示自己的预约）。
- **2026-09-16 `666f0040`**（本模块的 UX 收口）：登录态首页搬进会议模块
  （`isLoggedIn ? 模块 : Columns`）。落地页那一支从此**只在未登录时渲染**，于是：
  - `<ScheduledMeetingsList enabled={!!isLoggedIn}>` 的 `enabled` 恒为 `false`，
    组件第一行就 `return null` —— 永远不渲染；
  - 同一支里那个 `{isLoggedIn ? (快速会议/加入/预约) : (登录/加入)}` 三元也永远走
    false 分支 —— 那三个「登录态入口」同样进不去。

两处一起删掉，落地页只留「[登录] + [加入会议]」+ 分隔线 + 「更多」。未登录访客看到
的东西**一个像素都没变**，删掉的都是永远进不去的分支。

顺带发现测试为什么没发现：`Home.test.tsx` 把两个列表都 mock 成
`() => <h2>Scheduled meetings</h2>` —— mock 不看 `enabled`，所以那份死列表在测试里
照样渲染，而用例只断言了「未登录时『最近会议』消失」，没断言「『预约会议』也消失」。
现在补上了三条：未登录落地页两个列表都不在、`登录` 按钮在、`createMeeting` 不在。

### 3.17 四个一级页去掉副标题（2026-09-17 追加）

四个一级页的页头原先都是「标题 + 一行说明」（`pageTitle` + `pageLead`），按要求把说明
整行删掉，页头只留标题：

| 页面     | 删掉的文案键          | 原文案                                           |
| -------- | --------------------- | ------------------------------------------------ |
| 视频会议 | `library.videoHint`   | 发起或加入会议，也可以先预约。                   |
| AI 录音  | `library.recordHint`  | 录制线下会议与访谈，保存后可按需转写与生成纪要。 |
| 会议实录 | `library.notesHint`   | 集中查看会议与录音的音视频、文字记录和智能纪要。 |
| 智能纪要 | `library.minutesHint` | 已生成纪要的记录；与会议实录共用同一份资料。     |

- 三个页面文件（`Home.tsx` / `RecordingOverview.tsx` / `MeetingLibrary.tsx`）删掉
  `<p className={pageLead}>` 与随之不再使用的 `pageLead` import；`pageLead` 本身保留
  —— 三个次级页（录音详情 / 录制页 / 记录工作区）还在用。
- 文案键只从 `zh` / `en` 里删（`de` / `fr` / `nl` 本来就没有这几个键，走 en 兜底）。
- 页头动作行的对齐没变：`pageHeaderRow` 是 `align-items: flex-start`，标题（24px，
  行高 32）与右侧 32px 的按钮、搜索框本来就顶对齐。
- 走查在 `assertUnifiedPageChrome` 里加了一条：页头里 `header p` 数量必须是 0
  —— 四个页面一处定义、四页同时受检，以后谁再加回说明行会直接红。

### 3.18 页头那一栏对齐「消息」模块聊天窗口的标题栏（2026-09-17 追加）

参考 `ChatPane` 的聊天窗口标题栏（`paddingX: 1rem` / `paddingY: 0.625rem` /
`border-bottom: 1px` / `min-height: 3rem` / 16px bold 标题 / 32px 无边框图标钮），
把会议模块页头那一栏收成同一套。改动都在共享样式 `libraryStyles` 里，四个栏目页 +
三个次级页一起生效：

| 项            | 改前                                             | 改后                                                                    | 依据                                            |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| 页头底色      | 透出页壳浅灰 `surface.canvas`                    | `surface.default`（白）+ 1px `border.subtle` 分割线                     | 聊天窗口标题栏是白底靠分割线分层                |
| 标题字号/字重 | `headlineSmall` 24px/400                         | `titleMedium` 16px/**600**                                              | 那边是 16px bold                                |
| 垂直内边距    | `paddingTop: xl`(24)                             | `md`(12)                                                                | 那边 `paddingY: 0.625rem`(10)                   |
| 标题行        | `align-items: flex-start`、无最小高度、下边距 24 | `align-items: center`、`min-height: controlHeight.large`(48)、下边距 16 | 那边 `align-items: center` + `min-height: 3rem` |
| 动作间距      | `md`(12)                                         | `sm`(8)                                                                 | 那边 `gap: 0.5rem`                              |
| 次操作按钮    | `secondary`（线框 + 蓝边）                       | `secondaryText`（无边框 + 蓝字，hover 浅底）                            | 那边的动作是无边框的 ghost 图标钮               |

主操作仍是 `primary` 实心（「快速会议」「录音」）—— 聊天窗口那一栏没有主操作，但这两颗
是全模块最重的入口，保留层级。**文字标签也保留**（那边是纯图标；四个页面的按钮带标签
是前面几轮特意加的，不在这轮回退）。

一处**有意偏离 App 规则**：`we-meet-android/docs/page-backgrounds.md` §1 写的是
「一级页 = 顶部固定区浅灰 + 下方滚动区白」，这轮按聊天窗口标题栏把固定区改成白。
页壳本身仍是 `surface.canvas`，滚到尽头露出的仍是浅灰；下一个人若按 App 规则来核对，
以本节为准。

走查更新/新增断言：页头那一栏的实测底色必须是 `rgb(255,255,255)`、标题 16px 且
`font-weight: 600`、页头无副标题、页壳与滚动区底色不变；视频会议页那处「固定区浅灰」
的注释也改成量页头本栏。

### 3.19 二级导航栏栏头对齐「通讯录」（2026-09-17 追加）

以「通讯录」左栏（`ContactsSidebar`）为基准，统一会议模块二级导航栏（`MeetingNavPanel`）
栏头的**字号、位置与收起按钮**：

| 项         | 通讯录（基准）                            | 会议（改前）                             | 会议（改后）                                                           |
| ---------- | ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| 标题字体   | 16px / **bold**                           | `titleMedium` 16px / 500                 | 16px / **bold**（`fontWeight: 'bold'`）                                |
| 栏头内边距 | `1rem` / `0.75rem`                        | aside 12px + 栏头 8px，标题左缘落在 20px | **16 / 12**，标题左缘 16px（与导航行对齐）                             |
| 收起按钮   | 右端一颗 28×28、灰图标、hover 浅底        | 没有                                     | 同一位置同一档（`IconButton icon28`，`RiArrowLeftDoubleLine` 16px）    |
| 收起态     | 36px 窄条 + 展开按钮，状态写 localStorage | 没有                                     | 同左（窄条 36px、`RiLayoutLeftLine`、`we-meet:meeting-nav-collapsed`） |

实现要点：

- 栏头内边距**从 aside 移到栏头这一行**，导航行的容器补 `paddingX: sm`：标题左缘
  (16px) 与导航行文字左缘(8+8=16px)才对得齐 —— 这也是通讯录那边的做法。
- 收起状态放在 `MeetingNavPanel` 自己身上（通讯录是路由持有 + 窄条在中栏左侧；
  会议模块的栏与窄条都在同一个组件里，组件自己持有就够）。
- 收起/展开各一条 i18n 文案 `library.hideNav` / `library.showNav`（zh/en；de/fr/nl
  走 en 兜底）。⚠️ 这两条文案与「会议自己手写栏头」的做法在 3.20 里被**共享件取代**：
  文案改成 `shell` 命名空间的 `collapse` / `expand`（六个模块共用一句），本节保留
  只是记录当时的过程。

走查新增断言（基准数字写死在脚本里，通讯录那边改了而这边没跟上就会红）：栏头标题
`16px` / `font-weight: 700`、标题左缘距栏边 `16px`、栏头内边距 `16px`/`12px`、收起按钮
`28×28`、点击后只留 `36px` 窄条且 `localStorage` 记下 `'1'`、再点展开恢复栏头。另存
一张收起态截图 `meeting-notes-nav-collapsed.png`。`MeetingNavPanel.test.tsx` 也补了一条
「收起 → 窄条 → 展开 → 重挂载仍收起」的用例。

### 3.20 二级导航栏栏头收成**一处定义**，铺到六个模块（2026-09-17 追加）

3.19 只是把「会议」一个模块对齐到「通讯录」；这一轮按「消息 / 日历 / 审批 / 任务四
个模块一起收」的要求，把栏头抽成共享件，五个模块（含会议）全部改用它：

- `components/SubNav.tsx`：`SubNavHeader`（左标题、右动作 + 收起按钮）与
  `SubNavStrip`（收起后的 36px 窄条 + 展开按钮）。基准数字只写在这里 ——
  标题 16px / **bold**、栏头内边距 **16px / 12px**、收起按钮 **28×28**、窄条 **36px**；
  无障碍名默认取 `shell:collapse` / `shell:expand`（「收起导航栏 / 展开导航栏」），
  五个模块念同一句话。
- `components/useCollapsibleSubNav.ts`：收起态 + 跨路由持久化（每个模块一个 storage
  key，存 `'1'`/`'0'`，隐私模式下本会话仍可用）。单独成文件是因为 `SubNav.tsx` 同时
  导出组件，混着导出 hook 会让 Fast Refresh 失效（eslint 的
  `react-refresh/only-export-components` 会拦）。

各模块原先的差异（这次一并抹平）：

| 模块   | 标题字号           | 标题左缘                       | 收起按钮                                                                     |
| ------ | ------------------ | ------------------------------ | ---------------------------------------------------------------------------- |
| 消息   | 16px ✓             | 16px ✓                         | **新增**（栏头最右）                                                         |
| 日历   | 18px（`1.125rem`） | 20px（aside 内边距）           | **从内容工具栏搬进栏头**，原来是 32px 文字 `«`/`»`，且收起后没有任何展开入口 |
| 审批   | 18px               | 28px（aside 16 + 标题再补 12） | **新增**                                                                     |
| 任务   | 18px               | 28px                           | **新增**                                                                     |
| 会议   | 16px ✓             | 16px ✓                         | 上一轮已加，这轮改成走共享件                                                 |
| 通讯录 | 16px ✓             | 16px ✓                         | 它有，但**自己手写**（圆角 6px）→ 折进共享件，圆角归到 `control`(8px)        |

行为上的一处变化：日历收起后**不再是无路可退** —— 窄条里那颗「展开」在任何视图下
都在（原先只有内容工具栏那颗 `»`，且工具栏会随视图切换而变化）。

**通讯录也折进共享件了**（2026-09-17 同日追加）：它是这套基准的来源，早先自己手写了
栏头与窄条、收起按钮圆角写死 6px。现在它同样用 `SubNavHeader` / `SubNavStrip` /
`useCollapsibleSubNav`（storage key 与文案键沿用原值，用户偏好不丢），因此：

- 圆角统一到 `control`(8px) —— `check:foundations` 本来就不允许写裸 6px，这下没有例外；
- 窄屏那条路径照旧：同一个按钮在窄屏是「关移动抽屉」，展开按钮是「开移动抽屉」
  （`compactNav` 分支原样保留）；
- `contacts.page.hideNav` / `page.showNav` 两条文案随之作废，已从 zh/en/de/fr/nl 五个
  语言包里删掉（无障碍名改用共享件的 `shell:collapse` / `shell:expand`）。

**未动**：「云文档」（按要求留给单独任务）。

验证：

- 新增 `scripts/check-subnav-panels.mjs`（真实 Chromium，不需要后端）。它做两件事：
  ① **源码级**检查六个模块确实引用 `SubNavHeader` / `SubNavStrip` /
  `useCollapsibleSubNav`，且没有哪个模块自己画 `RiArrowLeftDoubleLine`（谁再手写一份
  栏头就会红）；② 在浏览器里量基准数字：16px / 700 / h2 / 左缘 16px / 内边距 16、12 /
  收起按钮 28×28 且在最右 / 窄条 36px / 无障碍名两句话 / 收起态写进 localStorage。
- `components/SubNav.test.tsx` 5 条：收起→窄条→展开→记住、从 storage 恢复、隐私模式下
  仍可收起、模块动作排在栏头里、toggle 身份稳定。
- `TaskWorkspaceNavigation.test.tsx` 补 `onCollapse` 并保留原断言；通讯录原有的
  「收起 → 窄条 → 展开 + 记住」用例（`ContactsRoute.test.tsx`）原样通过；会议走查
  （`check-meeting-pages-ui.mjs`）继续守着会议侧栏的同一套数字。
- 全量 `vitest` 161 文件 / 1039 条、lint / prettier / check:json / color / foundation /
  `tsc -b` / build 全绿。

顺带修掉一处走查里的**断言撞车**：视频会议页「查看全部 / 收起」那颗按钮按 `收起`
模糊匹配，栏头新增的「收起导航栏」也含这两个字 —— 改成 `exact: true`。

### 3.21 聊天窗口标题栏改成飞书那条一行式（2026-09-17 追加）

「消息」模块聊天窗口的标题栏按飞书改：**头像 + 标题 + 备注（可选，如「5 人」）、
不换行**。原先标题与群人数是上下两行，标题一长整栏就高一截。

排版抽成 `features/im/components/ChatHeader.tsx`（这一页原先没有单测，抽出来才有
地方量）：

- 头像在最左、**40px**（`IM_AVATAR_SIZE`，与会话列表里那一枚**同一档**；群聊用成员
  拼图，群自定义头像优先；私聊用对端头像），不参与挤压；
- 标题与备注在**同一行**：标题 `flexShrink: 1` + 省略号，备注 `flexShrink: 0`
  —— 名字再长也不会把人数挤掉；
- 整栏 `min-height: 3rem`（实测 61px = 40 头像 + 上下各 10 内边距 + 1px 描边）、
  `paddingX 1rem / paddingY 0.625rem`、1px 底分割线，右侧动作（通话 / 会议 / 添加
  成员 / ⋯）位置不变；
- 「私聊对端已离职」提示从标题下方搬进同一个备注位（仍然不拼进 `title` —— 那会顺着
  `peerName` / `roomName` 流进通话与会议室命名）。

首版把头像写成 24px，走查反馈「偏小，飞书那个头像和会话列表里的一样大」—— 现在两处
共用 `Avatar.tsx` 里的 `IM_AVATAR_SIZE`（40px），不再是两个各写各的数字。

验证：

- `ChatHeader.test.tsx` 4 条：三件套同框、只有给了 `onOpenSettings` 才是可点标题、
  没备注就不渲染备注位、动作仍在右侧。
- 新增 `scripts/check-chat-header.mjs`（真实 Chromium，只挂这一个组件、不需要后端）：
  ① **源码级**检查会话列表（`ConversationList`）与标题栏（`ChatPane`）都引用
  `IM_AVATAR_SIZE`（谁又各写各的尺寸就会红）；② 在 360px 宽的栏里塞一个超长群名，
  量「头像 40×40 / 头像在标题左 / 标题与备注竖向重叠（同一行）/ 标题与标题行都是
  `nowrap` / 超长标题确实被截断（`scrollWidth > clientWidth`）/ 备注不被挤掉且不越界 /
  栏高 ≤ 72px」，另存截图 `test-results/chat-header.png`。
  写这条时踩了一个坑：把外层容器设成**行向** flex 时，标题栏会按 max-content 撑开
  （min-content 贡献算的是 nowrap 文本的全宽），于是「省略号」永远量不到 —— 改成
  列向 flex（与应用里的真实结构一致）才量得准。

### 3.22 内容区标题栏收成一处定义（任务 / 通讯录 / 审批 / 消息，2026-09-17 追加）

3.21 把聊天窗口标题栏改成「头像 + 标题 + 备注、不换行」之后，按要求把这一形态铺到
其它模块的内容标题栏 —— 抽成 `components/TitleBar.tsx`（与 `SubNav` 同一套路：**基准
只写一处**）：

| 调用点     | 改前                                                               | 改后                                                      |
| ---------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 消息聊天栏 | 头像 24px + 标题 + 人数（本轮上一版）                              | 前导头像 **40px**（与会话列表同档）+ 标题 + 备注，同一行  |
| 任务       | `我负责的` 18px + `5 个任务` 13px **下一行**，栏高 64px            | 标题 16px bold + 备注 12px 灰字**同一行**，栏高 48px      |
| 通讯录     | `内部联系人` 15px + `14 人` 12px **下一行**                        | 同一行；右内边距仍按滚动条槽宽对齐（`paddingRight` 透传） |
| 审批       | 标题在**滚动区里**（`h2` + `padding: 1.5rem`，没有栏、没有分割线） | 标题栏独立成栏（白底 + 1px 分割线），正文自己滚           |

TitleBar 的三条规则（写死在共享件里）：① 标题与备注同一行、`nowrap`；② 标题
`flexShrink: 1` + 省略号，备注 `flexShrink: 0` 不被挤掉；③ 几何统一 —— 内边距
**16/8**、`min-height: 3rem`、白底 + 1px `border.subtle` 分割线。

（栏高在 3.23 / 3.25 里统一：先是 48px，走查反馈「消息模块头像太挤」后定为
**57px = 56 内容 + 1px 线**，六个模块一致。）

「会议」四个一级页上一轮已经是这一形态（白底 + 16px 标题 + 右对齐动作 + 分割线），
只是标题字重是 600、内边距 16/12 —— 本轮**没有**再动它：那一栏里还有搜索框与图标钮，
改内边距会把四个页面的钉头几何一起带动，收益只是 4px。若以后要完全对齐，把
`libraryStyles.pageHeaderRow` 的 `marginBottom`/`paddingTop` 换成 TitleBar 的这两档即可。

验证：

- `components/TitleBar.test.tsx` 4 条：前导 + 标题 + 备注同框、只有给了 `onTitlePress`
  才是可点标题、没有前导/备注就不渲染那两个槽、动作在右侧。
- 新增 `scripts/check-title-bar.mjs`（真实 Chromium，只挂这一个组件）：① **源码级**检查
  四个调用点（消息 / 任务 / 通讯录 / 审批）都引用 `TitleBar`；② 量两种形态 —— 有前导
  （40px 头像 / 栏高 57 / 白底 / 内边距 16、8 / 标题 16px bold / 备注 12px）与无前导
  （栏高 48），两种都要「标题与备注同一行、`nowrap`、超长标题被省略、备注不被挤掉」。
  另存截图 `test-results/title-bar.png`。
- `ContactsRoute.test.tsx` 里 5 处 `contacts-list-title` / `contacts-list-subtitle` 断言
  跟着改成共享件的 `title-bar-title` / `title-bar-meta`（标题栏抽走后 testid 只该有一套）。
- 全量 `vitest` 162 文件 / 1043 条、lint / prettier / color / foundation / `tsc -b` /
  build 全绿。

### 3.23 所有模块的标题栏统一（2026-09-17 追加；高度最终定为 57px，见 3.25）

走查反馈「会议模块的标题栏比其他模块都高」—— 量下来三条栏确实三个数：

| 栏                                                            | 改前                                                          | 改后     |
| ------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| 会议四个一级页的标题栏（固定区顶边 → 标题行底边）             | **60px**（`pageFixedTop.paddingTop` 12 + `pageHeaderRow` 48） | **48px** |
| 二级导航栏栏头（六个模块，`SubNavHeader`）                    | **52px**（`paddingY` 12 + 图标钮 28）                         | **48px** |
| 内容区标题栏（`TitleBar`：消息聊天栏 / 任务 / 通讯录 / 审批） | 48px（无前导）/ **57px**（40px 头像时）                       | **48px** |

**以 48px 为准**（`controlHeight.large`，也是行高与控件高这一档的既有 token）：

- 会议：`pageFixedTop` 不再自带 `paddingTop`，标题行的高度收在 `pageHeaderText` 的
  8px 纵向内边距里 —— 「固定区顶边 → 标题行底边」正好 48px；
- 二级导航栏栏头：`paddingY: 'sm'` + `minHeight: 48`（图标钮 28 + 上下各 8 = 44，
  由 `min-height` 兜到 48），因此左栏的「会议 / 消息 / 任务…」与右栏的内容标题在
  同一条水平线上；
- 聊天标题栏：40px 头像靠**4px**纵向内边距装进 48px（内联样式，不与 `barCls` 抢
  同一个原子类）；含 1px 描边实测 49px，与 48px 的其它栏差 1px（肉眼不可辨）。

为什么不是 57 / 60：48 是**既有 token**，不是为这次对齐新造的数；也只有它能让
「左栏栏头 + 右栏标题栏」两条并排的栏落在同一条线上。代价是聊天栏里 40px 头像
上下只剩 4px 留白 —— 比原先紧，但飞书/微信那一栏也是紧贴的形态。

验证：`check-title-bar.mjs` 断言两种形态同高（差 ≤1px）且 ≤50px；`check-subnav-panels.mjs`
断言栏头 `paddingTop 8px` + 栏高 48px；`check-meeting-pages-ui.mjs` 新增断言 ——
四个一级页的「固定区顶边 → 标题行底边」必须 **48px**（改前是 60，会红）。

**走查反馈「会议标题栏偏高、文字与按钮没居中」的复现与收口**：线上那份是 60px 的旧几何
（`pageFixedTop` 自带 12px 顶内边距把整行往下推，所以行内虽然居中，相对**栏**看就是偏下
12px）。除了上面那条栏高断言，`check-meeting-pages-ui.mjs` 又补了两条**居中**断言，并把
「视频会议」（首页）也纳入同一套页头断言：

- `标题必须垂直居中于标题栏`：标题盒中心与标题行中线之差 ≤1px；
- `右侧动作必须垂直居中于标题栏`：同上（按钮那一组）；
- `左栏栏头标题与右栏页面标题必须同一中线`：≤1px —— 两条并排的栏不能错开。

这两条都验证过**会在旧几何上报错**（把 `paddingTop` 改回 `'md'` → 「实际 60px」；把标题块
上边距顶偏 5px → 「实测偏 2.5px」）。

**线上复核（2026-09-18，用户报「部署后仍不正常」）**：把线上资源抓下来比对后确认 ——
线上 JS 里已经有 `title-bar-leading` 与 `paddingTop:"4px"`（`da139e17` 的标记），也就是
48px 那版**已经上线**；再把用户截图逐像素量了一遍：标题中心落在标题行顶边下方 24px
（= 48/2，居中），左栏「会议」与右栏「AI 录音」两条标题的中线差 0.4px（对齐）。**真正
剩下不对的是白条本身**：`pageHeaderRow` 当时还带 16px 下外边距，于是「固定区顶边 →
底部分割线」是 **64px**，标题相对那条分割线看起来是「上 24 / 下 40」—— 正是反馈里的
「标题栏偏高、没居中」。见 3.24。

### 3.24 标题栏白条收紧到 48px + 1px 线（2026-09-17 追加）

`pageHeaderRow` 去掉 16px 下外边距，这 16px 挪给**下面那一行**（实录/纪要的工具栏改成
`marginTop: lg`）：

| 页面                | 固定区内容      | 白条（顶边 → 分割线）                                |
| ------------------- | --------------- | ---------------------------------------------------- |
| 视频会议 / AI 录音  | 只有标题行      | **48 + 1px**（改前 64）                              |
| 会议实录 / 智能纪要 | 标题行 + 工具栏 | 48 + 16 + 40 + 16（标题栏自身仍是 48，被工具栏隔开） |

于是标题栏自己的白条与任务 / 通讯录 / 审批 / 消息**完全一致**（48 + 1px 线），标题正好
居中在那条白条里（实测：两页首条分割线都在 y=48，动作中心 23.5 = 48/2）。走查里对应的
断言：固定区高度 ≤49px（只在「固定区里只有标题行」时要求，即 `fixedTopHeight <= 60` 的
页面），加上标题/动作的中心偏移 ≤1px、左右两条栏的中线差 ≤1px。

### 3.25 标题栏高度最终定为 **57px**（2026-09-18 追加）

用户复查后的结论：会议那条与其它模块一致了 ✓，但 **48px 对消息模块偏小 —— 40px 头像
上下只剩 4px**，建议统一到 57px。于是把 3.23 定的 48 改成 57：

| 栏                                              | 3.23（48px）    | 现在                                                     |
| ----------------------------------------------- | --------------- | -------------------------------------------------------- |
| `TitleBar`（消息聊天栏 / 任务 / 通讯录 / 审批） | 48（含 1px 线） | **57**＝56 内容 + 1px 线（聊天栏里 40px 头像上下各 8px） |
| 二级导航栏栏头（六个模块）                      | 48              | **56**（无底分割线，内容高与 TitleBar 相同）             |
| 会议四个一级页的标题栏                          | 56 行 + 1px 线  | **56 + 1px 线 = 57**                                     |

一处定义：`components/TitleBar.tsx` 导出 `TITLE_BAR_MIN_HEIGHT`（`3.5rem` = 56px 内容
高），`TitleBar` 自己用 `calc(3.5rem + 1px)`（含底分割线），`SubNavHeader` 与会议模块的
`pageHeaderRow` 直接用 56 —— 三个调用面共用一个常量，谁要调高度只改这一行。

走查断言同步：`check-title-bar.mjs` 两种形态都必须是 **57px**、上内边距 8px；
`check-subnav-panels.mjs` 栏头 **56px**；`check-meeting-pages-ui.mjs` 标题行 **56px**、
固定区白条 ≤57px、栏头 **56px**。

### 3.26 通讯录「我的群组 / 外部联系人」也并进共享标题栏（2026-09-18 追加）

走查反馈：通讯录里这两个页面的内容标题栏还没统一，备注仍在下一行。原因是它们各自
手写了页头（`MyGroupsPanel` 的 `headerCls/titleCls/subtitleCls`、`ExternalContactsPanel`
的 `headerCls/titleCls/hintCls`），没走 `TitleBar`：

- `MyGroupsPanel`：标题「我的群组」+ 备注「共 N 个群组」同一行，搜索框留在右侧动作位；
- `ExternalContactsPanel`：标题「外部联系人」+ 备注（那句说明）同一行，「添加外部联系人」
  按钮留在右侧动作位；顺带把面板改成**列向 flex + 正文自己滚**，标题栏不再跟着列表滚走
  （与成员列表 / 我的群组同一结构）；「添加外部联系人」弹窗此前借用了面板那两个类，
  现在给它自己的一对 `dialogHeaderCls/dialogTitleCls/dialogHintCls`。

另外给 `TitleBar` 的备注加了 `maxWidth: 50%` + 省略号：短备注（人数 / 结果数）不受影响，
而「外部联系人」那句长说明在窄窗口下只会自己截断，不会把标题挤没或溢出栏外
（备注本身仍 `flexShrink: 0`，短备注永远看得见）。

验证：

- `check-title-bar.mjs` 的源码级调用点从 4 个扩到 **6 个**（多了这两个面板，谁再手写页头
  就会红）；并新增一段**真实浏览器**检查：夹具 `scripts/harness/title-bar-panels.tsx`
  挂起「外部联系人」面板，量标题栏 57px、标题与长备注**同一行**、备注不越出标题栏且在
  「添加」按钮左侧。截图 `test-results/title-bar-contacts-panels.png`。
  （「我的群组」依赖 IM SDK，dev 环境没有 `VITE_JUSI_IM_BASE_URL` 会直接抛错，由 jsdom 覆盖。）
- `ContactsRoute.test.tsx` 的群组视图用例补断言：标题栏的 `title-bar-title` /
  `title-bar-meta` 分别是「我的群组」与群组总数（备注不再另起一行）。
- 全量 `vitest` 162 文件 / 1043 条、lint / prettier / color / foundation / `tsc -b` /
  build 全绿。

### 3.27 内容标题栏按钮统一到「会议」那两档（2026-09-18 追加）

以「会议」标题栏的动作按钮为基准（`Home` 的「快速会议 / 加入会议 / 预约会议」、
`RecordingOverview` 的「录音 / 导入」、`MeetingLibrary` 的「搜索会议 AI」）：

| 角色   | 会议模块的写法（基准）                                                       |
| ------ | ---------------------------------------------------------------------------- |
| 主操作 | `variant="primary" size="action"` + `icon={<RiXxx size={18} aria-hidden />}` |
| 次操作 | `variant="secondaryText" size="action"` + 18px 图标                          |
| 纯图标 | `size="icon32"`（工具行 / 齿轮钮这一档）                                     |

按这个基准改掉的不一致：

| 模块       | 按钮                   | 改前                              | 改后                                            |
| ---------- | ---------------------- | --------------------------------- | ----------------------------------------------- |
| 任务       | 新建任务               | `primary action`，**无图标**      | 加 `RiAddLine` 18px                             |
| 任务       | 找回清单               | `secondaryText` **dense**，无图标 | `secondaryText action` + `RiInboxUnarchiveLine` |
| 通讯录     | 部门信息               | `secondaryText` **dense**         | `secondaryText action` + `RiInformationLine`    |
| 通讯录     | 添加（星标视图主操作） | `secondary` **dense**             | `primary action` + `RiAddLine`                  |
| 通讯录     | 添加外部联系人         | `secondary` **dense**             | `primary action` + `RiUserAddLine`              |
| 审批       | —（标题栏没有按钮）    | —                                 | —                                               |
| 消息聊天栏 | 图标钮                 | `icon32` ✓                        | 不变（与工具行同一档）                          |

一句话规则：**标题栏里不出现 `dense`**；每页只有一个主操作（品牌蓝实底 + 18px 图标），
其余是文字按钮 + 18px 图标。

验证：`check-title-bar.mjs` 增加**源码级**检查 —— 六个 `TitleBar` 调用点的
`<TitleBar …>` 区块里出现 `size="dense"` 就报错（任务 / 通讯录那几处就是这样漏出去的）；
「外部联系人」那段真实浏览器检查再加三条：按钮高 **40px**（action 档）、背景
**`rgb(40, 96, 217)`**（与「快速会议 / 录音」同一品牌蓝）、图标 **18×18** ✓。

### 3.28 云文档（另一个仓库）的两条栏对齐（2026-09-18 追加）

「云文档」不是本仓库的页面：它是 **iframe 内嵌的另一个 App**（`we-meet-docs`，
`DocsFrame.tsx` 只负责把 `docs.<域名>` 装进来），所以它的二级导航栏栏头与内容标题栏
都由那边渲染 —— 组件不能共用，只能对齐**值**（那个 App 已经通过 `yarn sync-we-meet-ui`
同步了本仓库的设计 token，字体 / 间距 / 控件高都在）。

在 `we-meet-docs`（分支 `docs-dev`，两个提交）里做的：

| 位置                                                       | 改前                                    | 改后                                                                                                                            |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 左栏页头（二级导航栏，`LeftPanelHeader`）                  | 内嵌时**只有一行动作**，没有标题        | 标题（`Docs`）+ 模块动作一行；`we-meet-ui.css` 新增 `.wm-subnav-header`：**56px 高、内边距 16/8、16px bold 标题、1px 底分割线** |
| 列表页标题栏（`we-meet-pages.css` 的 `.wm-grid-titlebar`） | 标题 500、内边距 16（高度对，字重偏细） | 标题 **700**（与宿主 `titleMedium + bold` 同档）、`min-height: 3.5rem` + 内边距 8/16、1px 底分割线                              |

**没有动**：文档页自己的 `DocHeader`（125px 高，可编辑标题 + emoji + 元信息 + 协作状态）
—— 那是**文档**的头，不是页面标题栏；压成 57px 会改掉编辑体验，走查明确说保持现状。

**桌面端的收起窄条（走查追加）**：桌面布局里左栏收起后原本**没有展开入口**（文档页用浮动
按钮收起、回到列表页就回不去了），现在补上 `LeftPanelStrip`：**36px 宽、上内边距 12px、
1px 右分割线、一颗 16px 图标的展开按钮**（与宿主 `SubNavStrip` 同档），两条桌面路径都接
（`MainLayoutContent` 的列表/新建页 + `ResizableLeftPanel` 的文档页）；**只在桌面渲染**，
平板/手机的抽屉 + 浮动条维持原样。样式在 `.wm-subnav-strip`，值由
`we-meet-bars.test.ts` 钉住，行为由 `LeftPanelStrip.test.tsx` 3 条守住。

验证：那边 `tsc --noEmit` / `eslint` / `stylelint` / `prettier --check` 全过，
`vitest`（cunningham / left-panel / header）10 条通过，token 对齐脚本
（`check-we-meet-token-alignment` 与 `sync-we-meet-ui` 检查模式）通过；新增
`src/cunningham/__tests__/we-meet-bars.test.ts` 把上面这两条值钉住（谁把高度/字重
改回去谁红）。真实浏览器实拍由走查人确认（那个 App 本地起需要后端）。

### 3.29 「日历」的内容标题栏并到「会议」那一条（2026-09-18 追加）

走查反馈：日历模块的内容标题栏与会议模块不是一条 —— 那边是白底 + 56px（+1px 线）、
右侧动作走 `action` 档按钮；这边是自己排的一行（没有白底与分割线，高度由分段控件的
纵向内边距决定，主操作只有「＋」文字前缀、没有图标，齿轮是手写的 32px `<button>`）。

| 位置         | 改前                                           | 改后                                                                      |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| 栏本身       | 自己排的一行：无白底、无分割线，高度随分段控件 | `libraryStyles` 的 `pageFixedTop` + `pageHeaderRow`（白底 + 56 + 1px 线） |
| 左槽         | 页面级 Tab（日历 / 会议室）                    | **不变**（两个 Tab 的文字就是页面名，不再另补一行标题）                   |
| 主操作       | `primary action`，「＋ 新建日程」（无图标）    | 加 `RiAddLine` 18px（与「新建任务 / 快速会议」同档）                      |
| 齿轮         | 手写 `<button>` 32px，只有 `title`、无焦点环   | 基元 `IconButton size="icon32"`（`label` 一处给出无障碍名 + Tooltip）     |
| 网格区内边距 | 与标题栏同在 20px 的容器里                     | 标题栏 16px、网格区 16px（与会议的固定区 / 滚动区同档，两条边仍然齐）     |

「会议」那条栏的共享定义是 `features/meetings/components/libraryStyles`（把它当**跨模块
样板**用已经有先例：`features/home/routes/Home.tsx` 也是从这里取的页头）。3.27 的
「每页一个主操作 + 标题栏里不出现 `dense`」在这一页照旧：只有「新建日程」是主操作，
齿轮是纯图标次操作。

验证：新增 `scripts/check-calendar-title-bar.mjs`（真实 Chromium）。

- **源码级**：`CalendarRoute.tsx` 必须引用 `pageFixedTop` / `pageHeaderRow` /
  `headerActions` 三个共享类（谁换回手写的一行，当天高度可能还是对的，下一个人改共享件
  时它就悄悄掉队）；标题栏区块里出现 `size="dense"`、或主操作没带 18px 图标，都报错。
- **真实浏览器**：栏高 56（+1px 线 = 57）、白底 `surface.default` + 1px `border.subtle`、
  左侧 Tab 与右侧动作都垂直居中（±1px）、左栏栏头与右栏标题栏同一中线；主操作
  40px + `rgb(40, 96, 217)` + 18×18 图标，齿轮 32×32 且有无障碍名，左槽仍是两个
  下划线 Tab（`日历 / 会议室`）；390px 下靠 `flex-wrap` 换行、不横向溢出。
  截图留档：[1180px](meetings-ux-assets/desktop-calendar-title-bar.png)、
  [390px](meetings-ux-assets/mobile-calendar-title-bar.png)（脚本自己写到
  `src/frontend/test-results/`）。

挂载这个页面有两个坑，都写在脚本的注释里了：① 直接 `import CalendarRoute.tsx` 会踩到
ESM 循环（`routes.ts` 静态 import 了 `@/features/calendar`，而后者又导出 `CalendarRoute`），
改为先 import 路由表再取 `routes.calendar.Component`；② 页面自己要用 `ConfirmProvider`
（日程的删除 / 改期确认），缺了它整棵树会被 React 卸载、页面上什么都量不到。

### 3.30 云文档两条栏的线上复查：栏头其实竖排了（2026-09-18 追加）

走查人拿线上截图（`meet.we-meet.online/docs`，镜子里的版本是 `ce339052`）回来对两条栏：

- **内容标题栏**：`[图标] 所有文档 [新建]` 缩成内容宽、被父容器的 `align-items: center`
  居中在内容区中间 —— 这条 `c56d88fc` 已经修了（补 `$width="100%"`，栏横贯内容列、
  标题贴左、主操作贴右）；线上那份镜子停在 `ce339052`，修它的提交在那之后。
- **二级导航栏栏头**：`Docs` **居中在上、收起按钮居中在下**（竖排），与「会议」那条
  左标题 / 右图标的一行**完全不是一回事**。这条当时没修掉，根因也不是几何值。

根因（写在这里，免得下次再从「值对不齐」查起）：栏头是 `Box` 渲染的，而
`components/Box.tsx` **无条件**吐一条 `flex-direction: ${$direction || 'column'}`
—— 栏头没传 `$direction`，所以它带的是 `column`。styled-components 是运行时注入、
排在全局 CSS **之后**，两边都是单类（0,1,0），于是那条 `column` 把
`.wm-subnav-header` 里的 `display / align-items / justify-content` 全部架空：
栏头成了「竖排 + 水平居中 + space-between」，正是截图里的样子。
`49e1e913` 修标题字重时踩的是同一类坑（所以标题那条当时就加了 `.wm-ui` 前缀），
栏头与动作组这两条漏了。

在 `we-meet-docs` 里改的（`we-meet-ui.css` 一处）：

| 位置       | 改前                                                                  | 改后                                                                      |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 栏头       | `.wm-subnav-header`（0,1,0）：被 Box 的 `column` 压成竖排、还多一条 1px 底分割线 | `.wm-ui .wm-subnav-header`（0,2,0）并**显式写回 `flex-direction: row`** + `gap: sm`；底分割线**删掉** —— 宿主 `SubNav.tsx` 的 `headerCls` 没有那一条（1px 线是**内容标题栏**的） |
| 动作组     | `.wm-subnav-header__actions`（0,1,0）：同样竖排，`gap: 4px`            | `.wm-ui .wm-subnav-header__actions`：`row` + `gap: var(--wm-space-xxs)`（2px，宿主是 `space.xxs`） |
| 动作字形   | 20px（沿用 `.wm-ui .c__button--icon-only` 那一档）                     | 16px（`--wm-icon-small`）—— 宿主的 icon28 钮里就是 16px 字形              |

验证：那个 App 本地起需要后端（Postgres / Keycloak / y-provider），所以这次改走一段
**真实 Chromium** 的对照脚本（一次性草稿，放在仓库外的 `.tmp/docs-bar-check/check.js`，
不入库）：把两份 CSS（HEAD 版 / 修好的版）按 `cunningham-style.css` 的 `@import`
顺序注入，再把 Box 的基样式作为**最后一段** `<style>` 打进去（如实模拟 styled-components
的注入位置），用 `getBoundingClientRect` 量盒子。量出来是：

| 量点                       | 改前（HEAD）            | 改后              |
| -------------------------- | ----------------------- | ----------------- |
| 栏头 `flex-direction`      | `column`                | `row`             |
| 栏高                       | 145（三个动作竖排撑开；线上列表页只剩收起一颗，量到 109） | **56** |
| 标题左缘 / 右缘留白        | 130 / 130（居中）       | **16** / 244      |
| 动作组排列 / 间距          | `column` / 4px          | **`row`** / 2px   |
| 收起图标字形               | 20×20                   | **16×16**         |
| 动作组到栏右缘             | 136                     | **16**            |

那个 App 侧：`tsc --noEmit`、`eslint`、`stylelint`、`prettier --check` 全过，
`vitest` 全量 **49 文件 313 条**通过。`we-meet-bars.test.ts` 把这次的坑钉住：
栏头必须带 `.wm-ui`、必须 `flex-direction: row`、**不许有 `border-bottom`**，
动作组必须 `row` + `--wm-space-xxs` + 16px 字形；另加一条源码级断言，
`DocGridTitleBar` 少了 `$width="100%"` 就红（3.28 那条线上问题不能回来）。

**仍然刻意不一样的两处**（不是漏掉）：① 内容标题栏标题用 700，宿主的共享
`TitleBar` 是 `titleMedium + bold`；「会议」页头用的是 `pageTitle`（600）—— 两者在
CJK 下落的是同一个 Bold 字面，观感一致，按共享件那一档写。② 标题前那枚模块图标
（所有文档 / 我的文档 / 与我分享 / 回收站）保留：那是筛选状态的指示，不是标题栏装饰。

### 3.31 云文档：栏头标题跟着语言走 +「新建」的落点（2026-09-18 追加）

同一轮走查的另一批反馈，两条都在 `we-meet-docs`：

| 反馈                 | 改前                                                                                     | 改后                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 栏头标题要多语言     | 栏头走的是 `t('Docs')`（i18n 通路早通），但 `zh.json` 里这条词条的值照抄了英文 `"Docs"` → **中文界面下栏头读作 "Docs"** | `zh.json` 的 `"Docs"` → **`云文档`**，与宿主一级 rail 上那个模块名同一个词                                                     |
| 「新建」只在两页出现 | `DocGridTitleBar` 右侧的主操作只看「内嵌 + 已登录」，于是**与我分享 / 回收站**两页也挂着一颗「新建」 | 规则收进 `docs-grid/conf.ts` 的 `canCreateDoc(target)`（**所有文档 / 我的文档**），与拖拽导入的落点 `withUpload` 共用同一条判断 |

两点说明：

- `Docs` 是那个 App 的**自称** —— 浏览器标签页、错误页标题、logo 的无障碍名都用它。改词条值
  等于中文下这些地方一起读作「云文档」，这是想要的（此前它是中文界面里唯一一处没翻的英文
  品牌名）。没有新造词条：英文下回落到 key 本身就是 `Docs`，另起一个 key 反而会让英文变成
  「Cloud docs」。
- 「新建」的规则只写在 `conf.canCreateDoc` 一处，按钮与拖拽落点都取它；回收站里给「新建」
  尤其没有落点（那页的文档只能恢复或彻底删除）。

验证：那个 App 侧 `tsc --noEmit`、`eslint`、`stylelint`、`prettier --check` 全过，
`vitest` 全量 **51 文件 320 条**通过。新增两份用例：`DocGridTitleBar.test.tsx`（6 条：
四页 × 有无「新建」，外加独立访问与未登录时为无）、`LeftPanelHeader.i18n.test.tsx`
（1 条：用**真 i18n** 切到中文断言栏头读作「云文档」、切回英文读作 "Docs" —— 既有那份
`LeftPanelHeader.test.tsx` 把 `t` 换成了 `s => s`，只能证明「标题走 t()」，看不到译文）。

### 3.32 「任务」标题栏与二级导航栏的纯图标钮收敛到基元（2026-09-19 追加）

起因是并排比对两页截图:「日历」与「任务」的齿轮不是一个颜色。日历那颗是透明底 + 灰图标
（`icon.secondary` `#666666`），任务那颗是浅蓝底 + 品牌蓝图（`action.selected.bg`
`#D6E4FF` / `.text` `#1E4DB3`）。

按规范后者不成立：`docs/component-system.md` §「图标按钮」写的是「纯图标操作统一使用
`IconButton`…普通动作使用 `quaternaryText`」，而 `action.selected.*` 在
`docs/color-system.md` 里的定位是「**选中行、选中 chip**」。一颗常驻、并未选中的齿轮画成
选中态容器色，等于一直向用户喊「我是激活的」；标题栏里也多出一块品牌蓝，与 3.27
「每页只有一个主操作（品牌蓝实底）」冲突。

| 位置                                                    | 改前                                                                       | 改后                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 任务 · 内容标题栏齿轮                                   | `Button variant="tertiary" size="icon32"`，只有 `aria-label`，文案「打开任务设置」 | 基元 `IconButton size="icon32" label=…`（无障碍名 + Tooltip 一处给出，并补焦点环）；文案改取 `settings.title`「任务设置」—— 与「日历」齿轮同一处，不再只有任务读成一整句话 |
| 任务 · 二级导航栏 11 颗 icon24（＋ / ⋯ / 齿轮 / 提交 / 取消） | `variant="tertiary"` + `taskNavigationActionButtonCss` 把底色按成 `transparent!` | 基元 `IconButton size="icon24"`（底色/图标色/焦点环不再由调用点拼）                |
| 任务 · 清单共享弹窗的「移除协作者」                     | `variant="tertiary"`（一颗**品牌蓝的删除钮**）                             | `IconButton variant="quaternaryDanger"`（平时中性灰、hover 才转红）               |
| 任务 · 标题栏两档的顺序                                 | …找回清单 / **设置齿轮** / **新建任务**（齿轮夹在主操作左边）              | …找回清单 / **新建任务** / **设置齿轮**（与 3.29「日历」那条栏同序：主操作贴左、齿轮在最右） |
| `taskNavigationActionButtonCss`                         | `transparent!` + `boxShadow: none!` + `greyscale.200` 悬停                 | 只留一条 `surface.muted` 悬停（理由见下）                                        |

根因：`tertiary` 取的是 `action.selected.*`（选中态容器色），而导航栏那批覆盖色只按掉了
`backgroundColor`、**没按 `color`** —— 于是底色透明了、图标仍是品牌蓝。这不是有意设计，
是绕规范打补丁留下的半成品。

**为什么导航栏那批还留一条悬停覆盖**：基元 `quaternaryText` 的悬停底色是
`surface.canvas`，而二级导航栏底色 `subNavBg` 就是 `greyscale.50` —— 浅色下两边同为
`#F6F6F6`，悬停完全看不见，直接违背组件系统「状态矩阵」里 hover 是 Web 必填项。所以这一处
显式换成高一档的 `surface.muted`（`#EEEEEE`；深色 `#242424`），两套主题都可见。

顺带记一笔**同类隐患**（没在这次里改）：「会议」二级导航栏栏头那颗齿轮
（`MeetingNavPanel.tsx:69`，3.27 的基准本身）同样挂在 `subNavBg` 上、且用基元默认悬停，
也就是**看不见悬停**；通讯录等模块的 `IconButton` 只要落在二级导航栏上都有这个问题。
真正的修法是在 `quaternaryText` 或 token 层给「canvas 面上的悬停」一个落点，影响面是五个
模块，不属于这次的范围。

验证：

- **新增源码级护栏** `scripts/title-bar-rules.mjs`（`check-title-bar.mjs` 与
  `check-calendar-title-bar.mjs` 共用），三条：① 标题栏区块里的 `size="icon24|28|32"`
  必须走基元 `IconButton`；② 纯图标钮不得带 `variant="primary|tertiary|primaryDark"`；
  ③ 纯图标钮必须排在主操作**右侧**（与 3.29「日历」那条栏同序）。
  拿 HEAD 版本的 `TasksRoute.tsx` 回放，①能命中那条 `icon32` 的 `<Button>`；
  ③拿本次调换前的顺序（齿轮在主操作左侧）回放同样命中 —— 注意③**必须两趟**
  （先定位主操作再比位置）：只走一趟的话，主操作在图标之后才出现，规则永远不会命中，
  初版就是这么写的，写完拿反例回放才发现。
- **修掉护栏自身的空转**：`check-title-bar.mjs` 原先用 `indexOf('/>', start)` 切
  `TitleBar` 区块，而 `<TitleBar title={…} meta={…}>` 的**第一个** `/>` 属于它内部第一个
  自闭合子元素（比如主操作的 `icon={<RiXxx size={18} aria-hidden />}`）——切出来的区间只有
  239–589 字符、含 **0** 个 icon 档按钮，3.27 说要拦的「dense 漏出去」那几处正是这样漏的。
  现在走 `extractElementInner` 按标签边界切（六个调用点实测 222–3486 字符），`dense` 这条
  从空转变成了真检查；复跑六个调用点 + 日历 header，均 0 违规。
- `npx vitest run src/features/tasks`：27 文件 / 177 条通过（含
  `TaskWorkspaceNavigation.test.tsx` 16 条 —— 菜单触发器换成 `IconButton` 后
  `MenuTrigger` 仍正常，`label` 仍是无障碍名）；
- `npx tsc -b`、`npx eslint src/features/tasks`、`npm run check:json`、
  `npm run check:colors`（58 组配对 / 40 个已迁移源）、`npm run check:foundations`
  （39 个已迁移源）、`prettier --check` 全过。
- **两个标题栏脚本的浏览器段也都跑了**（本地 `VITE_PORT=3187 npm run dev` + 真实
  Chromium，两个都 exit 0）：`check-title-bar.mjs` 六个调用点共用 TitleBar、两种形态都是
  57px；`check-calendar-title-bar.mjs` 日历栏 56px、主操作 40px 品牌蓝 + 18px 图标、
  齿轮 icon32 32×32、**齿轮在主操作右侧**、390px 无横向溢出。截图落在
  `src/frontend/test-results/`。
- **仍未覆盖**：「任务」标题栏没有自己的浏览器走查脚本（这次的换序只由源码级规则③守着）。
  要像「日历」那样量真实 DOM 顺序，需要照 `check-calendar-title-bar.mjs` 给任务页补一份
  —— 那页要 `ConfirmProvider` + 任务数据 fixture，属于下一批。
- **还没做**：`e2e/tasks.responsive.spec.ts-snapshots/` 的 4 张视觉快照重基线
  （需要 compose 任务后端；这 4 张自 2026-08-31 起就已与代码脱节，见
  [任务模块 UX](./tasks-ux-implementation-2026-09-12.md)）。

### 3.33 云文档：白面没有铺到最后一行（2026-09-19 追加）

走查截图：列表滚到底时，最后一行（以及它下面的留白）是**页面底色**（canvas 灰），
不再是列表那张白面 —— 看着像「最后一行的颜色用了背景色」。

根因不在颜色，在**白面的高度**：列表栏是 `main`（`height: 100dvh` + `overflow-y: auto`）
的 flex 项，而组件上带着上游 `c82ff199` 留下的 `$minHeight="0"`（那次把列表滚动从卡片
挪给 `main` 时加的）—— flex 于是可以把它压到**一屏高**。白面到不了列表末尾，超出的
那一截（长度正好等于 `main` 的滚动量）就落回 `main` 的底色上。

上游 `main` 也是白的，所以这个 shim 一直没暴露；是 3.28 把它改成 canvas（让列表立成
一张白面）之后才看得见的 —— **我们自己的底色改出了上游的一个潜在布局 bug**。

| 位置                             | 改前                                        | 改后                                                                |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| 列表栏 `.wm-ui.--docs--doc-grid` | `$minHeight="0"` 生效 → 栏高 = 一屏（1000） | `min-height: auto`（flex 项的自动最小尺寸 = 内容高，3877），值收在表里 |

没有去改组件那一行：与同处那条 `max-width: 1200px`（同样覆盖组件的 `$maxWidth`）
一个理由 —— 上游 diff 越少越好。

验证：那个 App 本地起需要后端，所以照 3.30 的办法再写了一段**真实 Chromium** 对照
（`.tmp/docs-bar-check/repro-last-row.js`）：按 `MainLayout`/`MainContent` 与
`DocsGrid` 的真实值拼 DOM，注入**真 CSS**（HEAD 版 / 修好的版各来一遍），并把 Box 的
基样式按 styled-components 的注入位置放在最后；40 行 × 1000px 视口，滚到底量：

| 量点                | 改前（HEAD）                     | 改后                |
| ------------------- | -------------------------------- | ------------------- |
| 栏 `min-height` 计算值 | `0px`                         | **`auto`**          |
| 栏高 / 内容高       | 1000 / 3877                      | **3877** / 3877     |
| 末行底边 − 白面底边 | **−2861px**（在白面**外**）      | **+16px**（在白面内） |
| 截图里的白面        | 完全消失（整屏 canvas）          | 1200px 白面铺满内容列 |

那边 `stylelint` / `prettier --check` / `eslint` 全过，`vitest` 全量 **51 文件 321 条**
通过（`we-meet-bars.test.ts` 新增一条把 `min-height: auto` 钉住）。

### 4. 顺带修掉的缺陷

- **窄屏左列不收起**：`/meeting` 登录态直接渲染定宽 `MeetingNavPanel`，390px 下会把
  正文挤成一字一行。现在与另外三个栏目页同一套规则——`moduleRow` + `moduleContent`
  布局、`<md` 隐藏左列、顶部换成 `MeetingModuleNav` 胶囊行。
- **窄屏栏目行没有样式**：`MeetingModuleNav` 原先是裸 `<a>`，现在是有明确选中态
  （`action.selected.*` + `aria-current`）的胶囊行。
- **重复的「预约会议」入口**：会议主区顶部动作行与「待开始的会议」节标题右侧各有一颗
  同款次按钮、指向同一个动作，同一屏内两颗让人犹豫点哪个。已删除节标题那颗，
  入口只留永远在屏上的动作行；`ScheduledMeetingsList` 的 `onSchedule`（唯一调用点就是
  这里）随之删除，组件不再需要向外暴露这个槽位。
- **`check:foundations` 的过期断言**：`SearchBox` 收口后 Bots / Members /
  MeetingRooms / CalendarManagementDialogs 的 import 串已变，断言仍写旧串，
  CI 一直是红的。已按现状更新这四条（不涉及产品代码）。

### 3.34 录制工作区与纪要 / 翻译 / 字幕面板收口（2026-09-19 追加，Web 端「遗留」第一批）

上一轮结尾的「遗留」写着：

> 录制工作区与纪要/翻译面板仍是手写样式，属于下一批业务域收口。

这一节就是那一批。范围是 AI 录音 / 会议实录 / 智能纪要三个子模块里**页面之外的**
全部 UI：录制工作区（`MeetingRecordWorkspace`）与它引用的每一个面板、录制页
（`AudioRecording`）的两个面板、以及列表页用到的次级件。

#### 1. 颜色 / 圆角 / 间距：50 处裸值 → 语义角色

18 个文件里 50 处裸色族、14 处裸 `fontSize`、25 处数字圆角，逐条换成语义角色。
浅色取值逐一相等（`greyscale.200` = `border.subtle`、`greyscale.600` =
`text.secondary`、`primary.700` = `text.link`、`0.75rem` = `card`…），所以**浅色是零视觉
回归**；深色下这批文件第一次真正跟着主题翻转 —— 此前 `greyscale.50` / `primary.100`
这类是固定色阶，深色下会留一条刺眼的浅色带。

几条判断口径：

| 原写法                            | 换法                                    | 为什么                                              |
| --------------------------------- | --------------------------------------- | --------------------------------------------------- |
| `_hover: { backgroundColor: 'primary.100' }` | `surface.canvas`              | `action.selected.*` 的定位是「选中行 / 选中 chip」；拿它当悬停会让「划过」和「选中」长得一样。共享基元（`secondaryText` / `quaternarySurface` / `rowSurface`）的悬停一律是 `surface.canvas` |
| `backgroundColor: 'danger.700'` + `color: 'white'` | `status.danger` + `status.danger.text` | `default / on-default` 必须成对取 |
| `fontSize: '1.25rem'` + `fontWeight: 700` | `textStyle: 'titleLarge'`      | 纪要正文的一级标题，对应「重要内容标题」那一档      |
| `fontSize: '0.8125rem'`（13px）    | `textStyle: 'bodySmall'`                | 13px 不在 15 档字阶里；这一处是辅助信息，取 12px 的 `bodySmall` |
| `lineHeight: 1.7 / 1.9`（逐字稿正文） | **保留**，只把 `fontSize` 换成 `textStyle` | 长文阅读行距是内容决定的几何，不是排版节奏 —— 与「视频舞台、日历网格不套栅格」同一条 |

#### 2. 顺带查出的四个真缺陷

| # | 缺陷 | 证据 | 处理 |
| - | ---- | ---- | ---- |
| 1 | **智能纪要 scope 术语两端两套** | 实录「我的内容 / 共享内容」↔ 纪要「归我所有 / 与我共享」 | 已在上一轮 §3.2 #6 统一（zh 对照核实：两处现在都是「我的内容 / 我参与的 / 共享内容」）；**App 端没落地，见 Android 记录 D1** |
| 2 | **`text.error` 不是 token** | `TranscriptSegment.tsx` / `RecordRenameControl.tsx` 的 `color: 'text.error'`：`text` 组只有 `primary/secondary/disabled/inverse/link`，这条声明一直静默失效（错误文案不是红的） | 换成 `status.danger`（`StateHint` 的错误色同源） |
| 3 | **`fontSize: 'sm'` 不是 token** | `LiveCaptureTranscript.tsx` —— 本仓库 `fontSizes` 只挂了 10–64 的数字档，`'sm'` 解析不到任何变量 | 换成 `textStyle: 'bodySmall'` |
| 4 | **导出语言下拉与导出按钮的无障碍名都在渲染 key 原文** | ① `SummaryExportControl` 写 `t('language.zh')`，而 `meetings.json` **没有顶层 `language`**（正确键是 `translation.language.*`）→ 下拉里显示 `language.zh`；② `transcriptExport.download` 五个语言包的值都是**单花括号**（`下载 {format}`），i18next 只插值 `{{var}}` → 读屏念作「下载 {format}」 | 两处都改；并为 ① 补了一条用**真语言包**复核的用例（原来的 `t` 是 stub，只证明「请求了哪个键」，看不出键存不存在） |

#### 3. 无障碍：错误播报与提交加载态

- **14 处错误播报用的是 `role="status"`**（polite），这 11 个文件里 `role="alert"` 为 0 ——
  与 `docs/component-system.md` §「加载、空数据与错误状态」相反。这些 `message` 槽同时
  承载成功回执（`*.accepted` / `*.saved` / `*.copied` / `applied` / `undone`）与失败
  （限流 / 权限 / 结果不确定 / 冲突 / 复制失败），所以判断收在
  `components/liveRegionRole.ts` 一处：`receiptRole(message)` 与
  `statusRole(status)`（后者的值域是服务端任务状态，`failed / uncertain / unavailable /
  canceled / incomplete` 同样要断言式播报）。调用点只写 `role={receiptRole(message)}`。
- **提交类动作零 `loading`**：`HumanSummaryPanel` / `SummaryTaskActions` /
  `SummaryAutomationControl` / `SummarySharingControl`（确认 + 重提）/
  `SummaryExportControl`（确认 + 重提）/ `RecordQuestionPanel` 的 8 颗提交按钮都只有
  `isDisabled={busy}`，补上 `loading={busy}`（基元会同时置 `aria-busy` 并阻止重复提交）；
  生成进度区补 `aria-busy`。
- **智能纪要工具行选中态不可见**：五颗 `variant="tertiary"`（= `action.selected.bg`）
  配 `aria-pressed`，而 `buttonRecipe` 没有 `[aria-pressed]` 样式 → 当前打开的那一颗与
  其余四颗长得一模一样。改成选中 `tertiary` / 未选中 `secondaryText`。
- **`SpeakerAttributionControl` 的搜索框写死 `backgroundColor: 'white'`**：深色主题下
  输入文字继承翻转后的 `text.primary`（#E2E2E5），白底上对比度约 **1.3:1**（门槛
  4.5:1）。底与前景改成成对的 `surface.default` / `text.primary`，并补 `_disabled`。
- **`TranscriptSegment` 的四颗手写按钮**：「显示 / 隐藏原文」此前 hover 与
  focus-visible **都没有**（键盘走到它看不见焦点），「恢复」缺 focus-visible；补齐。
  同文件里错误提示的 `<p role="alert">` 保留（角色本来就对）。

#### 4. 顺着审计清掉的三处结构问题

- **智能纪要的兜底页重新引入了限宽版心**：§3.1 明确「去掉 `maxWidth` + `margin: 0 auto`」，
  但 `MeetingLibrary` 的「能力不可用」分支还是 `maxWidth: 960px` + 居中。改成与四个
  栏目页共用的 `pageShell('canvas')`；状态本身也从面板级的 `StateHint` 换成页面级的
  `PageState`（§3「页面主内容区的空状态使用 `PageState`」）。
- **录制页在用户资料未到时返回空片段**（白屏），另外三个栏目页这一档都是
  `StateHint state="loading"`。已对齐。
- **`MeetingMaterialsLinks.tsx` 是死代码**：全仓库无任何引用（`materials.title` /
  `materials.hint` 也只有它在用）。删除组件 + 五个语言包里那一段（与 §3.16 处理未登录
  落地页死代码同一做法）。
- **`npm run lint` 在 HEAD 上本来就是红的**：`UploadMediaPlayer.tsx` 挂着一条
  `eslint-disable-next-line jsx-a11y/media-has-caption`，而该规则只认原生
  `<audio>` / `<video>`，这里渲染的是自定义 `MediaElement` → `--report-unused-disable-directives`
  报「unused directive」。已在 HEAD 上复现并删除该指令，顺带两处 prettier 未格式化的
  测试文件也一并格式化（`npm run check` 由红转绿）。

#### 5. 护栏：把这一批纳入强制清单

- `check:colors` 的 `migratedSourceUrls` 新增 30 个会议文件（40 → **71** 个已迁移源）；
- `check:foundations` 的 `migratedTypographySources` / `migratedShapeSources` 新增同一批
  （39 → **70**）；
- 两处**覆盖缺口**补上：`libraryStyles.ts` 此前只在 shape/color 清单里、自己再写裸
  `fontSize` 不会红，现在进 typography 清单；`migratedElevationSources` 此前**一个会议
  文件都没有**（裸 `boxShadow` 无守卫），现在把四页共用件与三个一级页纳进来。
- 仍未覆盖、有意留着的：**裸 spacing**（`check:foundations` 根本不扫
  `padding/margin/gap`，会议模块还有 ~110 处 `0.625rem` / `1.25rem` 这类不在 10 档上的
  值 —— 它们不是「没换」，是本来就没有对应档位，见下）、`brand.N` 数字档（`panda.config`
  明确指定它替代裸 `primary.N`，但与 color-system §3.1「不得引用数字档」的口径冲突，
  属规范层待收敛）、以及检查器 `legacyDirectColor` 的键名白名单不含
  `borderLeftColor` 这类变体。

**没动 `routes/MeetingDetail.tsx`**（视频会议详情，45 处）：它属于「视频会议」这一个
栏目，不在这一批的三个子模块里。


- `npx tsc -b`；
- `npm run check:colors`：58 组对比度配对 + 40 个已迁移源文件；
- `npm run check:foundations`：10 档 spacing、15 档字阶、7 档圆角、6 档高程、
  12 档组件尺寸、39 个已迁移源文件；
- `npx vitest run`：159 个文件 / 1029 条用例全绿。两条用例的同步方式随基元切换做了
  调整：`MeetingDetailPanel` 的「进入会议」不再把「加载中」写进按钮文案（改由
  `aria-busy` + 转圈表达），测试改为显式等待按钮可用；`MeetingLibrary` 的范围筛选
  从 `aria-pressed` 按钮组变成 `tablist/tab`，断言随之改为 `aria-selected`；
  3.11 的表格另加两条：表头四列 + 创建时间排序（`aria-sort` 与行序）与「切视图不丢
  翻过的页」；
- `node scripts/check-meeting-library-ui.mjs`（仓库既有的真实 Chromium 走查，含工作区）
  通过 —— 次级页收口时它先报出「页面壳高度塌陷、搜索框点不动」，改完复跑通过；
- `node scripts/check-meeting-pages-ui.mjs`（真实 Chromium，需先起 dev server）：
  四个栏目页在 1180px 与 390px 下均无横向滚动、分段控件键盘可切换、图标开关
  `aria-pressed` 同步、Tab 焦点有可见描边、浅深两套主题下语义 token 正确翻转；
  样板的每条规则都有断言锁住：
  - 铺满：页壳宽度必须**等于**内容列宽度（限宽居中的版心会让这条失败），行左右
    留白 ≤ 20px（列表视图量的是整行，卡片视图量的是卡片）；
  - 钉头：列表区滚到底时页头 / 搜索框 / 入口块的 `y` 原封不动，且外层内容列
    `scrollTop` 仍为 0（只能有一个滚动区）；视频会议页还额外断言标题行**同一行内**
    右对齐的三个入口（按竖向重叠判定）也钉住、且三个按钮各带一个 `aria-hidden` 图标；
  - 行风格：录音页的行首图标块仍是 48×48、标题 16px；实录 / 纪要的表格主单元格改为
    「32px 图标块 + 两行文字」（会议时间 · 来源 + 状态徽标），行高比原来的卡片矮一档；
  - 表格（3.11）：表头四列只出现一次、所有者列取服务端显示名且桌面端不在副行重复、
    创建时间默认降序且点击后切升序（行序跟着变）、卡片视图里不残留表头、390px 收起
    表头并把所有者并进副行；
  - 数据量：归档 / 录音 fixture 各 24 条、视频会议 fixture 13 + 13 条（页面按 20 条
    截断），否则列表滚不动、钉头那条断言会退化成恒真。
    次级页（录音详情 / 记录工作区 / 录制页）不在这个脚本里：前两页要从 wouter Route
    取 `:recordId`，而该脚本是「同一个 root 连续挂载多个页面」的写法，路由状态会滞后；
    它们分别由 `check-meeting-library-ui.mjs`（工作区）与 `check-capture-ui.mjs`
    （录制页，见下方遗留）覆盖。
### 3.35 逐字稿搜索与命中高亮（2026-09-19 追加，两端同改）

拿飞书妙记的实机截图逐屏比对之后，落了这件参考稿里已经成型、我们这边还没做的事。
（另一件「会议信息页排版」只动了 App 端，记在
`we-meet-android/docs/会议三子模块_UIUX_优化记录.md`。）

#### 1. 搜索框：手写 input + 「搜索」按钮 → 共享 `SearchBox`

`OriginalSearch` 是这一轮之前**最后一个还在手写搜索框**的会议组件：原生 `<input>`
自己拼描边圆角，旁边再挂一颗 `secondary` 的「搜索」按钮，还有一个「清空」按钮。

- 结构换成共享 `SearchBox`（放大镜 + 清空 ✕ + `type="search"`），与列表页 §3.13
  完全同一口径：**提交只剩回车**，清空输入立刻撤销关键词筛选，✕ 只清空不提交
  （基元里写了 `type="button"`，否则回车与 ✕ 会互相干扰）。
- `TranscriptSegment` 新增 `highlight`：服务端只负责把**不匹配的行**过滤掉，
  命中的**是哪个词**此前完全没标出来 —— 一条里出现多次时尤其难找。
  现在正文里所有命中处包 `<mark>`（`action.selected.*` 成对取色，浅色 6:1 /
  深色 5.5:1），大小写不敏感，且**按字面量匹配**（`indexOf` 而不是正则：搜索词
  直接来自用户输入，拼进正则会让 `(`、`*` 这类字符抛异常或误匹配）。
  参考稿里那一行「中国」被高亮成浅蓝底，就是这个位置。

对应截图：`01.jpg` / `06.jpg` 里逐字稿顶部的搜索框，以及正文里被高亮的关键词。

#### 3. 剩下的手写表单控件收进基元（同一轮）

审计在 §B3 里点过：这一模块的表单控件大量绕过基元。这一轮把**能一一对应**的收掉：

| 项 | 处数 | 改法 |
| -- | ---: | ---- |
| 原生 `<input type="checkbox">` | **9 处 / 7 文件**（`AudioRecording`、`CaptureTranscriptionPanel`、`CaptureTranslationPanel`×2、`InterpretationPanel`、`PrivateTranslationPanel`×2、`RecordPurge`、`SummarySharingControl`） | 全模块此前**只有 `RecordingUpload`** 用了共享 `Checkbox`。原生 input 拿不到 §2「状态矩阵」要求的 hover / pressed / focus-visible / selected / disabled —— 键盘走到它看不见焦点、深色下也不跟随主题。基元的 API 是 RAC 口径（`isSelected` / `onChange(value)` / `isDisabled`），逐处按原文替换 |
| 连 `className` 都没有的裸 `<input>` | **3 处 / 2 文件**（`SummarySharingControl` 的搜索、`TranscriptReplacementControl` 的查找/替换） | 走共享 `Input`：32px 钉高 + 语义描边/底色/前景 + hover / invalid / disabled。此前是**浏览器默认外观**，深色主题下是白底黑字，与同屏控件对不上 |

**有意没换**的：`SummaryTaskActions` / `HumanSummaryPanel` / `RecordQuestionPanel` 里那几个
`className={field}` 的 input 与 select（`field` 是面板自己的一档几何，换成 32px 的 `Input`
会改变弹层里的密度），以及 `TranscriptSegment` 的编辑框（`lineHeight: 1.7` 是逐字稿的阅读
行距，基元不表达这个）。这三处留在「未做」清单里，理由写在那边。

**验证**：`SummarySharingControl` / `TranscriptReplacementControl` / `CaptureTranscriptionPanel`
/ `CaptureTranslationPanel` / `InterpretationPanel` / `PrivateTranslationPanel` / `RecordTrash`
的既有用例（含 `getByRole('checkbox', { name: … })`）全部通过 —— RAC 的 Checkbox 仍是
`role="checkbox"` 且无障碍名取子节点文本，断言不必改。

## 验证

#### 2026-09-19（§3.34 / §3.35 那一批）的验证记录

```bash
cd src/frontend
npm run lint                                  # eslint . --ext ts,tsx --max-warnings 0 → 0
npm run check                                  # prettier --check ./src → All matched files
npm run check:json                             # 120 files
npm run check:locales                          # 5 语言包 meetings + capture 结构一致
npx tsc -b                                     # 0
npm run check:colors                           # 58 组配对 / 71 个已迁移源(原 40)
npm run check:foundations                      # 71 个已迁移源(原 39)
npx vitest run                                 # 182 文件 / 1271 条
```

- §3.35 落地后复跑同一组命令：**lint / prettier / tsc / check:colors / check:foundations
  仍全绿**，`vitest` **181/182 文件、1269/1271 条**通过（新增 3 条 `TranscriptSegment`
  的高亮用例：多次命中、大小写不敏感、正则元字符按字面量处理）。
- §3.35 第 3 节（表单控件收进基元）之后又复跑一次：同样全绿，
  `vitest` 仍是 181/182 文件（余下那 2 条见下）。

- **`npm run lint` 在 HEAD 上本来就是红的**（见 §3.34 第 4 节），这批顺手修掉，现在 0 错误。
- **`npm run check`（prettier）在 HEAD 上也是红的**：`prettier --check ./src` 报 **8 个文件**
  —— `chunkedUpload.test.ts`、`transcriptFollow.test.tsx`、`transcriptSync.test.ts`、
  `CaptureAudioPlayer.tsx`、`CaptureTranscriptionPanel.test.tsx`、
  `SpeakerAttributionControl.tsx`、`SpeakerAttributionControl.test.tsx`、
  `TranscriptExportControl.tsx`，**全部落在 `features/meetings` 里**（这批动的正是这个
  模块），已在 HEAD 上复现并 `--write` 修好。
  注：只对 `./src` 跑 prettier —— 仓库 `check` 脚本的范围就是它；我一度顺手 `--write`
  了 `scripts/*.mjs`（不在 `check` 范围内），已**全部回滚**，避免无关 churn。
- `vitest` 全量：**2 条 `RecordingUpload.test.tsx` 超时**（「reports a cancelled transfer」
  与「shows byte progress」）。两条在**单独跑该文件时都通过**（18/18），单条耗时约 3.2s
  对 5s 预算 —— 是并行负载下的敏感超时，与本次改动无关（`RecordingUpload.tsx` 本次**一个
  字节都没改**，`git diff --stat` 对该文件为空）。
- 随文案 / 角色改动同步的用例 2 条：`SummaryExportControl.test.tsx` 的语言下拉断言
  （旧断言把 bug 当成期望值 `language.zh`，改成 `translation.language.zh` 并**用真语言包
  复核键存在**）、`InterpretationPanel.test.tsx` 的失败播报由 `status` 改 `alert`。
- `prettier --write` 顺带格式化了两个此前未通过 `prettier --check` 的测试文件
  （`CaptureTranscriptionPanel.test.tsx` / `SpeakerAttributionControl.test.tsx`，纯格式）。

#### 2026-09-16 那批的验证记录（走查脚本与后端）

- 后端（3.3 的改动，用本地 Postgres + Redis 按 CI 的环境变量跑）：
  `core/tests/rooms/test_api_video_meetings.py`（含新增的「只有真预约进 scheduled」）、
  `core/tests/tasks/test_rooms.py`（3 条：关闭无人进的房间 / 保留延迟预约与有人进过的
  房间与刚建的房间 / 已关闭的不再动）、`core/tests/test_task_registry.py` 与
  `core/tests/test_tasks_registration.py`（新任务模块的注册守卫）—— **12 passed**。
  `core/tests/rooms` + `core/tests/tasks` 全量跑有 32 条失败，**在改动前的干净树上
  同样失败**（字幕 / 更新权限 / webhook / 附件那几条，缺 S3、LiveKit 等 compose 依赖），
  与本次改动无关。

### 走查截图（2026-09-16 那批）

#### 2026-09-16 那批的留档

`check-meeting-pages-ui.mjs` 会覆盖写 `src/frontend/test-results/` 下的同名文件；
下面这份是本次改动验收时的留档（全部为 fixture 假数据）。

- 视频会议主区：[1180px](meetings-ux-assets/desktop-video-meetings.png)、
  [390px](meetings-ux-assets/mobile-video-meetings.png)
- 会议实录：[1180px](meetings-ux-assets/desktop-records.png)、
  [390px](meetings-ux-assets/mobile-records.png)
- 智能纪要：[1180px](meetings-ux-assets/desktop-minutes.png)
- AI 录音：[1180px](meetings-ux-assets/desktop-recording.png)、
  [390px](meetings-ux-assets/mobile-recording.png)
- 深色主题（实录）：[1180px](meetings-ux-assets/dark-records.png)
- 会议记录工作区（钉头 + 内部面板自滚）：[390px](meetings-ux-assets/mobile-workspace.png)
- 录制页（钉头 + 表单卡）：[1280px](meetings-ux-assets/desktop-capture.png)
- 日历内容标题栏（3.29）：[1180px](meetings-ux-assets/desktop-calendar-title-bar.png)、
  [390px](meetings-ux-assets/mobile-calendar-title-bar.png)

## 遗留（未在本次改动）

- ~~录制工作区与纪要/翻译面板仍是手写样式，属于下一批业务域收口。~~
  **2026-09-19 已完成，见 §3.34。**
- **`routes/MeetingDetail.tsx`（视频会议详情）仍有 45 处裸值**（20 色族 / 17 裸
  `fontSize` / 8 数字圆角）。它属于「视频会议」这一个栏目，不在 §3.34 的三个子模块里，
  保持一致没动 —— 下一批把「视频会议」自己收口时一起做。
- **面板族里的手写表单控件**：9 处原生 checkbox 与 3 处裸 `<input>` 已由 §3.35 第 3 节
  收进基元。**仍未换**的三类（有意，不是漏掉）：① `SummaryTaskActions` /
  `HumanSummaryPanel` / `RecordQuestionPanel` 里 `className={field}` 的 input / select
  —— `field` 是面板自己的一档几何，换成 32px 的 `Input` 会改变弹层里的密度，要换得连
  弹层一起改；② `TranscriptSegment` 的编辑框（`lineHeight: 1.7` 是逐字稿的阅读行距，
  基元不表达这个）；③ `RecordOriginals` 之外的 4 处手写搜索入口。
- **27 处 `toLocaleString()` 没传界面语言**：列表页那两处带 NaN 守卫与 `i18n.language`，
  次级页与面板没跟上 —— 中文界面 + 英文浏览器时日期读作英文格式。修法是一处
  `formatDateTime(value, locale)` 共享件（含解析失败的守卫，照 §3.2 #3 的口径），
  但它要动 15 个文件、且面板里有多处是 `toLocaleTimeString`，属独立的一批。
- **`AudioRecording` 之外的面板首屏仍未走 `StateHint`**：12+ 个面板用
  `<p role="status">` 手写加载 / 错误（`RecordTrash` / `RecordPurge` / `RecordDocuments`
  / `HumanSummary*` / `Summary*` 各面板）。这批只改了「错误播报的角色」与「提交按钮的
  loading」，把整块换成 `StateHint` 是版面改动，留给下一批。
- **轮询面板一次失败即整块换成错误文案**（`SummarySharingControl` / `SummaryExportControl`
  / `SummaryNotificationPanel` / `SummaryAutomationControl`），会卸载 Editor 并丢掉已选
  人员与草稿 —— 与 §3「后台刷新已有数据时保留旧内容」相反。属行为改动，需单独回归。
- `scripts/check-capture-ui.mjs` 在**本次改动之前就已经失败**（`播放` 按钮那一步超时）：
  我在 HEAD 上复跑过同一条命令，报错与行号完全一致，所以与本次版面改动无关，
  没在这个分支里顺手修。
- **列表标题的机器名**（见 3.2 第 5 条）：Web 侧只加了悬停提示，真正的修法是后端在
  导入时给友好默认名（例如「上传文件 · 9月16日 15:01」）并提供重命名入口 —— 需要产品定，
  没自作主张改后端。
- **已经躺在库里的无时间房间**：3.3 的自动关闭要等 beat 跑起来才会清掉历史存量
  （每小时一次、宽限期 86400 秒）。**手动清理的完整方法见 3.3「手动清理（存量）」**
  ——`manage.py close_abandoned_rooms --dry-run` 先看再执行。列表侧已经不受影响
  —— 它们本来就不再进 `scheduled` 了。
- **带 session 但从未关闭的房间**（有人进过、房主没点结束、webhook 也没到）没被这个
  任务处理：`reconcile_active_meeting_sessions` 只管 status=ACTIVE 的会话，房间的
  `ended_at` 仍是空的。要不要一并收掉需要产品定 —— 关掉会影响「复用房间」的语义
  （`overview` 的说明里写着复用房间保留精确 session id），我没擅自扩大范围。
