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

### 3.1 列表页版式：铺满 + 只滚列表（2026-09-16 追加）

「会议实录 / 智能纪要」这一对列表页（同一个 `Library` 组件，`minutes` 档切换）
按任务列表（`TasksRoute` 的 `workspace → main → header + modeTabs + listRegion`）
的版式重排：

- **去掉限宽居中版心**：原先 `maxWidth: 1120px` + `margin: 0 auto`，窗口一宽两侧
  就各留一大块空白。现在页壳铺满内容列，横向内边距用 `space.lg`（16px，即规范里
  「页面边距」那一档，与任务列表的 `paddingX: 1rem` 同值）。
- **只有列表滚动**：页壳是占满高度的 flex 列，列表以上部分（窄屏栏目行、页头、
  范围筛选、搜索/筛选面板）`flexShrink: 0` 并带 `border.subtle` 底边分隔线；
  列表区 `flex: 1; minHeight: 0; overflow: auto`。滚到底也始终看得见当前筛选条件，
  与任务列表的手感一致。
- 顺带把搜索框上限的 `maxLength={200}` 补回（`SearchBox` 不带该属性，改在受控值上截断）。

分工要记一笔：**视频会议与 AI 录音两个页面仍是限宽居中的版式**（`maxWidth: 1120px`），
本次只按需求改了列表页；要不要一起铺满、要不要也做成「固定页头 + 只滚列表」，
属于产品取舍，留待确认。

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
- `npm run check:colors`：58 组对比度配对 + 38 个已迁移源文件；
- `npm run check:foundations`：10 档 spacing、15 档字阶、7 档圆角、6 档高程、
  12 档组件尺寸、37 个已迁移源文件；
- `npx vitest run`：159 个文件 / 1027 条用例全绿。两条用例的同步方式随基元切换做了
  调整：`MeetingDetailPanel` 的「进入会议」不再把「加载中」写进按钮文案（改由
  `aria-busy` + 转圈表达），测试改为显式等待按钮可用；`MeetingLibrary` 的范围筛选
  从 `aria-pressed` 按钮组变成 `tablist/tab`，断言随之改为 `aria-selected`；
- `node scripts/check-meeting-pages-ui.mjs`（真实 Chromium，需先起 dev server）：
  四个页面在 1180px 与 390px 下均无横向滚动、分段控件键盘可切换、图标开关
  `aria-pressed` 同步、Tab 焦点有可见描边、浅深两套主题下语义 token 正确翻转；
  列表页另加两条断言锁住 3.1 的版式——页壳宽度必须等于内容列宽度（限宽居中的
  版心会让这条失败）、卡片左右留白 ≤ 20px；列表区滚到底时页头与搜索框的 `y`
  必须原封不动，且外层内容列 `scrollTop` 仍为 0（只能有一个滚动区）。归档
  fixture 也补到 26 条，否则列表滚不动、第二条断言会退化成恒真。

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

## 遗留（未在本次改动）

- 录制工作区与纪要/翻译面板仍是手写样式，属于下一批业务域收口。
