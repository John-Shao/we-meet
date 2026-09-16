import { css } from '@/styled-system/css'

export const libraryLayout = css({
  maxWidth: '960px',
  width: '100%',
  margin: '0 auto',
  padding: 'xl',
  overflowY: 'auto',
  overflowWrap: 'anywhere',
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

/** 入口块排布:AI 录音页的「开始录音 / 导入音视频」并排,窄屏换行。 */
export const entryTileRow = css({
  display: 'flex',
  gap: 'lg',
  flexWrap: 'wrap',
})

/**
 * 二级页里的「入口块」。原先「开始录音」和「导入音视频」各画一套浅蓝底 +
 * 数字圆角,并排放着却差几个像素 —— 现在只有这一份外观定义。
 *
 * 用 `<a>` 还是 `<button>` 由调用点决定(跳页 vs 唤起文件选择),这里只管外观;
 * 因此不能依赖标签选择器。
 */
export const entryTile = css({
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'md',
  minWidth: '10rem',
  minHeight: '7rem',
  paddingX: '2xl',
  paddingY: 'lg',
  border: 'none',
  borderRadius: 'panel',
  textStyle: 'labelLarge',
  textDecoration: 'none',
  cursor: 'pointer',
  color: 'brand.700',
  backgroundColor: 'brand.100',
  transition: 'background-color token(durations.fast)',
  _hover: { backgroundColor: 'brand.200' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
  _disabled: {
    cursor: 'not-allowed',
    color: 'text.disabled',
    backgroundColor: 'surface.muted',
  },
})

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
