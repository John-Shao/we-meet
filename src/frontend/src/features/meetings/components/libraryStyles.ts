import { css, cx } from '@/styled-system/css'

/**
 * 会议模块的页面样板（以「智能纪要」页验收通过的那一版为准，2026-09-16）。
 *
 * 三类角色，取值只有这一处定义：
 *   ① 页壳 —— 铺满内容列（不再限宽居中）、占满高度、自己管滚动；
 *   ② 固定区 / 滚动区 —— 列表页钉头，仪表盘式页面整页滚；
 *   ③ 列表与行 —— 图标块、标题、辅助信息、区块标题。
 *
 * 模块内**不再有限宽居中的版心**：四个栏目页与三个次级页都走 `pageShell`，
 * 原来那个 960px 的 `libraryLayout` 已随次级页收口一并删除。
 */

/**
 * 页壳。**不再设 maxWidth / margin auto**：原先版心锁在 1120px 居中，窗口一宽
 * 两侧就各留一大块空白。`surface` 只有纪要阅读器要换成 `default`（白底阅读面），
 * 其余页面用 `canvas`，卡片才立得起来。
 */
export const pageShell = (surface: 'canvas' | 'default' = 'canvas') =>
  css({
    flex: '1 1 0',
    // `height: 100%` 与 `flex: 1 1 0` **两个都要**:前者给「父级不是 flex 列」的页面
    // 兜底 —— 会议记录工作区直接挂在 <Screen> 下,没有 MeetingModuleShell。只写 flex
    // 的话高度由内容决定,里面的 contentRegion 会塌成 0 高,Tabs 与搜索框跟着变成
    // 零尺寸、点不动(这个回归是被 scripts/check-meeting-library-ui.mjs 抓到的)。
    height: '100%',
    minHeight: 0,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: `surface.${surface}`,
  })

/**
 * 列表以上部分：固定不滚（列表页）。底边分隔线把「固定的工具区」和「滚动的列表」
 * 分开，与任务列表（TasksRoute 的 header/modeTabs）同一套做法。
 */
export const pageFixedTop = css({
  flexShrink: 0,
  paddingX: 'lg',
  paddingTop: 'xl',
  borderBottom: '1px solid token(colors.border.subtle)',
})

/** 唯一的滚动区。内边距留在里面，最后一行才不会贴着底。 */
export const scrollRegion = css({
  flex: '1 1 0',
  minHeight: 0,
  overflow: 'auto',
  paddingX: 'lg',
  paddingBottom: '2xl',
})

/**
 * 工作区内容区：占满剩余高度，**自己不带滚动** —— 转录 / 纪要 / 发言人这些面板
 * 各自滚（见 MeetingRecordWorkspace 的 Tabs），外面再套一层会出双滚动条。
 */
export const contentRegion = css({
  flex: '1 1 0',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  paddingX: 'lg',
  paddingBottom: 'xl',
})

/** 详情 / 工作区页头：返回链接 + 标题 + 元信息，与列表页头同一档留白。 */
export const detailHeaderStack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  marginBottom: 'lg',
})

/** 返回链接（详情 / 工作区页）：与列表页的「更多」同族 —— 蓝字 + hover 下划线。 */
export const backLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'xs',
  width: 'fit-content',
  textStyle: 'labelLarge',
  color: 'text.link',
  textDecoration: 'none',
  borderRadius: 'field',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

/**
 * 页面主标题。四个栏目页(home 的 h1、录音、实录、纪要)共用一档,
 * 之前是 1.5rem/bold 与 1.25rem 各自手写,并排切栏目时标题会跳字号。
 */
export const pageTitle = css({
  textStyle: 'headlineSmall',
  color: 'text.primary',
  margin: 0,
})

/** 页面副标题/说明。 */
export const pageLead = css({
  textStyle: 'bodyMedium',
  color: 'text.secondary',
  margin: 0,
})

/** 页头文字块(标题 + 可选说明)。 */
export const pageHeaderText = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  minWidth: 0,
})

/**
 * 页头行:左侧标题块,右侧动作组。四个栏目页共用同一档下边距,
 * 此前 1rem / 1.5rem / 1.75rem 三种写法让并排切栏目时内容会上下跳。
 */
export const pageHeaderRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'lg',
  marginBottom: 'xl',
})

/** 页头右侧动作组:窄屏换行、右对齐(实录 / 纪要 / 视频会议共用同一档)。 */
export const headerActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 'md',
})

/** 区块标题(「待开始的会议」「历史会议」这类列表小节标题)。 */
export const sectionTitle = css({
  textStyle: 'titleMedium',
  color: 'text.primary',
  margin: 0,
})

/** 分组小标签(「进行中」「归档」这类 eyebrow)。 */
export const groupLabel = css({
  textStyle: 'titleSmall',
  color: 'text.secondary',
  margin: 0,
})

/** 列表行主标题。 */
export const rowTitle = css({
  textStyle: 'titleSmall',
  color: 'text.primary',
  margin: 0,
})

/** 卡片主标题(实录/纪要卡片)。 */
export const cardTitle = css({
  textStyle: 'titleMedium',
  color: 'text.primary',
  margin: 0,
})

/** 列表行辅助信息(来源、时间、状态)。 */
export const rowMeta = css({
  textStyle: 'bodySmall',
  color: 'text.secondary',
  margin: 0,
})

/** 元信息行(图标 + 来源 / 时间):与列表行的辅助信息同一档,详情页头用。 */
export const metaLine = cx(
  rowMeta,
  css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'sm' })
)

/**
 * 列表底部的「更多 / 查看全部」动作:居中文字链。既是 `<a>`(跳转)也是
 * `<button>`(就地展开)的样式,所以把按钮的默认外观一并清掉。
 */
export const listMoreLink = css({
  display: 'block',
  width: '100%',
  padding: 'lg',
  textAlign: 'center',
  textStyle: 'labelLarge',
  color: 'text.link',
  textDecoration: 'none',
  cursor: 'pointer',
  backgroundColor: 'transparent',
  border: 'none',
  borderRadius: 'field',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

/** 列表区块标题 + 统一间距(进行中/历史记录/历史录音/预约会议/全部智能纪要共用)。 */
export const sectionHeading = cx(
  groupLabel,
  css({ marginTop: 'xl', marginBottom: 'md' })
)

/**
 * 一级页的**内容底**:页壳仍是 `surface.canvas`(钉住的头部因此保持浅灰),滚动区
 * 铺白。这条规则来自 App 的页面层级规范
 * (`we-meet-android/docs/page-backgrounds.md` §1):一级页面 = 顶部固定区域浅灰 +
 * 下方滚动区域白。
 *
 * 四个栏目页都用它,头部颜色才不会一页一个样(纪要页原先是整页白壳)。
 */
export const contentSurface = css({ backgroundColor: 'surface.default' })

/**
 * 样板列表:无边框行 + 行间距(智能纪要的阅读列表形态),四个栏目页共用。
 *
 * 取代「整块白卡 + 行分隔线」:一级页的内容底本来就是白的,再套一层白卡只会剩下
 * 一圈描边,而行间距比 1px 分隔线更接近纪要页的观感。
 */
export const listStack = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
})

/**
 * 行首图标块 —— 样板的行都从这枚 48px 品牌浅蓝底 + 24px 蓝图标开始。
 * 深浅两套主题由 `brand.*` 成对翻转，不写裸色值。
 */
export const rowIconTile = css({
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  width: '3xl',
  height: '3xl',
  borderRadius: 'control',
  backgroundColor: 'brand.50',
  color: 'brand.600',
})

/**
 * 行首图标块(表格视图)—— 与 `rowIconTile` 同族配色,但只有一档控件高:表格行
 * 的主单元格是「图标 + 标题 + 辅助信息」两行,48px 的大图标块会把行高顶回去。
 */
export const rowIconTileCompact = css({
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  width: 'controlHeight.compact',
  height: 'controlHeight.compact',
  borderRadius: 'field',
  backgroundColor: 'brand.50',
  color: 'brand.600',
})

/** 卡内行:一段式间距、悬停浅底、焦点环内缩(与列表边缘对齐)。 */
export const rowSurface = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'lg',
  minHeight: 'controlHeight.large',
  padding: 'lg',
  color: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
  transition: 'background-color token(durations.fast)',
  _hover: { backgroundColor: 'surface.canvas' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '-2px',
  },
})

/** 行正文列。 */
export const rowBody = css({ minWidth: 0, flex: 1 })

/** 行标题(样板):卡片主标题一档,最多两行。 */
export const rowHeadingClamped = cx(cardTitle, css({ lineClamp: 2 }))

/** 行标题(密集列表):同样一档,单行省略。 */
export const rowHeadingOneLine = cx(
  cardTitle,
  css({
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })
)

/** 行辅助信息 —— 横排一行(`时间 · 来源`,卡片用)。 */
export const rowMetaRow = cx(
  rowMeta,
  css({
    marginTop: 'sm',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'sm',
  })
)

/** 行辅助信息 —— 竖排多行(来源/状态、时间,密集列表用)。 */
export const rowMetaBlock = cx(
  rowMeta,
  css({
    marginTop: 'sm',
    display: 'flex',
    flexDirection: 'column',
    gap: 'xxs',
  })
)

/**
 * 「会议」二级页的外壳:左列常驻导航面板,右列页面内容。
 *
 * 右列必须 `flex: 1 1 0` + `minWidth: 0`:面板是定宽(flexShrink 0),
 * 而页面自己的 <main> 写着 width:100% —— 不钉 minWidth 的话 100% 会把面板
 * 也算进去,把面板挤出视口。
 *
 * 右列同时是**竖直 flex**而不是普通块:进会预览页的内容根靠
 * `flexGrow: 1 + justifyContent: center` 做竖直居中,一旦中间插了一层块级容器,
 * 那条 flexGrow 就失效、预览卡片会贴到顶上。保持 flex 列,它才继续是 flex 项。
 */
export const moduleRow = css({
  display: 'flex',
  height: '100%',
})

export const moduleContent = css({
  flex: '1 1 0',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
})
