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
