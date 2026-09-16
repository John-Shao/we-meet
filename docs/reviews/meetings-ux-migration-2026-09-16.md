# 会议模块 UX 收口（2026-09-16）

## 范围

按 [Color System](../color-system.md) D 阶段与 [Foundation System](../foundation-system.md)
的口径，收口「会议」模块的四个栏目页及其共享件：

| 页面 | 路由 | 组件 |
| --- | --- | --- |
| 视频会议 | `/meeting` | `features/home/routes/Home.tsx` |
| AI 录音 | `/meeting/recording`、`/meeting/recording/history/:id` | `RecordingOverview.tsx`、`RecordingDetail.tsx`、`RecordingUpload.tsx` |
| 会议实录 | `/meeting/notes`、`/meeting/records/:id` | `MeetingLibrary.tsx` |
| 智能纪要 | `/meeting/minutes` | 同上（`minutes` 档） |

共享件：`libraryStyles.ts`、`MeetingNavPanel`、`MeetingModuleNav`、
`ScheduledMeetingsList`、`RecentMeetingsList`、`MeetingDetailPanel`。

不进本次范围：录制工作区（`AudioRecording` / `MeetingRecordWorkspace`）、纪要面板
（`RecordSummaryPanel` 等）与翻译/字幕面板——它们属于「会中/录后处理」工作区，
按业务域各自收口，本次只保证它们引用的共享样式（`libraryLayout`、`moduleRow`、
`moduleContent`）语义与取值不变。

## 改了什么

### 1. 颜色：裸色族 → 语义角色

模块内不再出现 `greyscale.*` / `primary.*` / `white` 这类裸引用：

| 原写法 | 现在 | 说明 |
| --- | --- | --- |
| `greyscale.000` / `greyscale.50` | `surface.default` / `surface.canvas` | 卡片、页面底 |
| `greyscale.100/200` 边框 | `border.subtle` | 分隔线与描边 |
| `greyscale.600/900` | `text.secondary` / `text.primary` | 正文与辅助信息 |
| `primary.100` + `primary.700` | `brand.50/100` + `brand.600/700`、`action.selected.*` | 浅蓝底 / 蓝字 / 选中态 |
| `primary.500` 焦点描边 | `border.focus` | 与全站统一焦点环同源 |
| `primary.500` + 白字实心块 | `action.primary.bg` + `action.primary.text` | 成对使用，深色下自动倒转 |
| `scheduledCard.*` | 保持不变 | 预约会议卡片的既有产品 token |

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

| 页面 | 滚动手感 | 列表风格 |
| --- | --- | --- |
| 智能纪要 `/meeting/minutes` | 钉头 | 样板本体（无边框阅读行） |
| 会议实录 `/meeting/notes` | 钉头 | 网格卡（同一个 `Library` 组件） |
| AI 录音 `/meeting/recording` | 钉头（入口块 + 标题固定） | 卡内行，已从「裸 24px 图标」换成样板行 |
| 视频会议 `/meeting` | 钉头（标题行 + 三个入口固定） | 两段卡内行，已换成样板行几何与字阶 |
| 录音详情 `/meeting/recording/history/:id` | 钉头（返回 + 标题） | 资料卡 |
| 会议记录工作区 `/meeting/records/:recordId` | 钉头（返回 + 标题 + 元信息），滚动交给内部 Tabs 面板 | 面板自带 |
| 录制页 `/meeting/recording/capture` | 钉头（返回 + 标题） | 表单卡 + 面板 |

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

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 「预约会议」列表**没有条数上限**：待开始的会议可能十几条，把「历史会议」整段顶出首屏；而「历史会议」自己有 20 条上限 + 「更多」，两段手感不一致 | 默认只预览 10 条，超出时给「查看全部（N）」/「收起」**就地展开**（预约列表没有天然的「更多」目标页）；`home.showAll` / `home.collapse` 是既有 key，未新增文案 |
| 2 | 同一条记录在「AI 录音」与「会议实录」里**版式不同**：前者竖排两行（来源 / 时间），后者横排一行（时间 · 来源） | 统一成单行 `时间 · 来源`（`rowMetaRow`）；顺带把上传处理状态也加到实录行 —— 原先「上传中/失败」只在录音页看得见，而实录才是管理记录的入口 |
| 3 | 日期解析失败时**把服务端原始值原样画出来**（`return iso`） | 三个格式化函数（预约 / 历史 / 详情面板）都改成先 `Number.isNaN(date.getTime())` 判定，解析不了返回 `null`，那一行元信息整段不渲染 |
| 4 | 宽屏下**搜索框被拉到近千像素** | 搜索框封顶 `28rem`（448px）；铺满版式 + 不限宽时输入起点离内容列左缘太远 |
| 5 | 列表主标题是**机器生成的文件名**（`share_68a4…`、`新录音-260915-142621`） | Web 端先补上 `title` 提示（省略号截断的长标题悬停可看全）；**根治要后端在导入时给友好默认名 + 提供重命名入口**，属于产品取舍，未擅自改 |
| 6 | 「我的内容」这件事**两页两套文案**：实录「我的内容 / 共享内容」，纪要「归我所有 / 与我共享」 | 统一到实录那套（zh）：纪要 scope 改为「我的内容 / 我参与的 / 共享内容」。英文本就一致；fr/de/nl 没有这两组 key，回落英文 |

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

| 页面层级 | 顶部固定区域 | 下方滚动区域 |
| --- | --- | --- |
| 一级：消息 / 日历 / 会议 / 通讯录 / 云文档 / 任务 | 浅灰 `#F6F6F6` | 白 `#FFFFFF` |
| 二级及更深：新建 / 详情 / 设置 / 搜索 | 白 `#FFFFFF` | 浅灰 `#F6F6F6` |

视频会议是**一级页**，所以页头保持浅灰（页壳 `surface.canvas` 不动），**列表滚动区改成
白**（`surface.default`）—— 改动只有一处：`Home.tsx` 的 `listRegion` 加
`backgroundColor: 'surface.default'`，页头所在页壳仍是 canvas，于是「浅灰头部 + 白色内容」
两段式成立，与 App 的会议页一致。深色主题由 token 自动翻转。

走查脚本新增断言把这两块底色锁住：页壳必须是 `rgb(246, 246, 246)`（固定头部露出的底色）、
列表滚动区必须是 `rgb(255, 255, 255)`。

### 3.5 四个一级页面统一到「智能纪要」这一版（2026-09-17 追加）

要求是「以智能摘要页面为基准，统一会议模块 4 个一级页面的风格，包括标题、工具按钮、
头部颜色、列表风格」。落地时把基准页的每一处拆成可复用的类，四个页面共用同一份定义：

| 部位 | 统一后的规则 | 之前的分歧 |
| --- | --- | --- |
| 头部颜色 | 页壳一律 `surface.canvas`（浅灰），只有滚动内容区铺 `surface.default`（白）—— App 一级页规则 | 纪要页整页白壳；AI 录音 / 视频会议的滚动区也是浅灰 |
| 标题 | `pageTitle`（headlineSmall 24px）+ `pageLead`（次要色说明） | 视频会议 / AI 录音只有标题，没有说明行 |
| 工具按钮 | 页头右侧 `headerActions`，一律 `Button size="action"` + 18px 图标，右对齐 | AI 录音是两枚大入口块；「搜索会议 AI」没有图标 |
| 范围筛选 | `SegmentedControl appearance="underline"` | 实录用 pill、纪要用 underline，同为一级页却两种控件 |
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

## 验证

- `npm run lint`、`npm run check`（prettier）、`npm run check:json`；
- `npx tsc -b`；
- `npm run check:colors`：58 组对比度配对 + 40 个已迁移源文件；
- `npm run check:foundations`：10 档 spacing、15 档字阶、7 档圆角、6 档高程、
  12 档组件尺寸、39 个已迁移源文件；
- `npx vitest run`：159 个文件 / 1027 条用例全绿。两条用例的同步方式随基元切换做了
  调整：`MeetingDetailPanel` 的「进入会议」不再把「加载中」写进按钮文案（改由
  `aria-busy` + 转圈表达），测试改为显式等待按钮可用；`MeetingLibrary` 的范围筛选
 从 `aria-pressed` 按钮组变成 `tablist/tab`，断言随之改为 `aria-selected`；
- `node scripts/check-meeting-library-ui.mjs`（仓库既有的真实 Chromium 走查，含工作区）
  通过 —— 次级页收口时它先报出「页面壳高度塌陷、搜索框点不动」，改完复跑通过；
- `node scripts/check-meeting-pages-ui.mjs`（真实 Chromium，需先起 dev server）：
  四个栏目页在 1180px 与 390px 下均无横向滚动、分段控件键盘可切换、图标开关
  `aria-pressed` 同步、Tab 焦点有可见描边、浅深两套主题下语义 token 正确翻转；
  样板的每条规则都有断言锁住：
  - 铺满：页壳宽度必须**等于**内容列宽度（限宽居中的版心会让这条失败），卡片左右
    留白 ≤ 20px；
  - 钉头：列表区滚到底时页头 / 搜索框 / 入口块的 `y` 原封不动，且外层内容列
    `scrollTop` 仍为 0（只能有一个滚动区）；视频会议页还额外断言标题行**同一行内**
    右对齐的三个入口（按竖向重叠判定）也钉住、且三个按钮各带一个 `aria-hidden` 图标；
  - 行风格：三页的行首图标块都必须是 48×48、标题都是 16px；
  - 数据量：归档 / 录音 fixture 各 24 条、视频会议 fixture 13 + 13 条（页面按 20 条
    截断），否则列表滚不动、钉头那条断言会退化成恒真。
  次级页（录音详情 / 记录工作区 / 录制页）不在这个脚本里：前两页要从 wouter Route
  取 `:recordId`，而该脚本是「同一个 root 连续挂载多个页面」的写法，路由状态会滞后；
  它们分别由 `check-meeting-library-ui.mjs`（工作区）与 `check-capture-ui.mjs`
  （录制页，见下方遗留）覆盖。
- 后端（3.3 的改动，用本地 Postgres + Redis 按 CI 的环境变量跑）：
  `core/tests/rooms/test_api_video_meetings.py`（含新增的「只有真预约进 scheduled」）、
  `core/tests/tasks/test_rooms.py`（3 条：关闭无人进的房间 / 保留延迟预约与有人进过的
  房间与刚建的房间 / 已关闭的不再动）、`core/tests/test_task_registry.py` 与
  `core/tests/test_tasks_registration.py`（新任务模块的注册守卫）—— **12 passed**。
  `core/tests/rooms` + `core/tests/tasks` 全量跑有 32 条失败，**在改动前的干净树上
  同样失败**（字幕 / 更新权限 / webhook / 附件那几条，缺 S3、LiveKit 等 compose 依赖），
  与本次改动无关。

### 走查截图

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

## 遗留（未在本次改动）

- 录制工作区与纪要/翻译面板仍是手写样式，属于下一批业务域收口。
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
