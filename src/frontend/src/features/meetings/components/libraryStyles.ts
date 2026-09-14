import { css } from '@/styled-system/css'

export const libraryLayout = css({
  maxWidth: '960px',
  width: '100%',
  margin: '0 auto',
  padding: '1.5rem',
  overflowY: 'auto',
  overflowWrap: 'anywhere',
})

/**
 * 「视频会议」二级页的外壳:左列常驻导航面板,右列页面内容。
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
