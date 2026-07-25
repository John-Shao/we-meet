import { css } from '@/styled-system/css'

/**
 * 原生 <select> 统一外观:隐藏系统默认箭头,换成中性灰(#7C7C7C =
 * greyscale.500,深浅色同值,两种主题都成立)自绘下拉箭头,并在右侧留位。
 * 边框/圆角仍由各处自身样式决定,故 cx(本地样式, selectChrome) 即可。
 *
 * **深色模式下的展开列表**:`appearance: none` 之后 Chromium 不再按
 * color-scheme 推导的系统配色画弹出列表,改用元素自身的 background-color;
 * 而多数调用方只设了边框和字号,背景是 transparent → 列表回落成白底,页面
 * 那套浅色文字落上去整列不可见(实测:admin 会议室的层级时区)。所以这里
 * 必须显式兜底:给 select 一个底色,并**逐条给 option 上色** —— 后者才是
 * 真正决定每一行可读性的,且选择器落在 option 而非 select 上,与调用方设在
 * select 上的背景不会撞。`backgroundColor` 取 greyscale.000,与既有调用方
 * (SelectDialog / Audit filterControl)同值,cx 叠加谁赢都一样。
 *
 * 注:列表的选中高亮仍由系统绘制,靠 root 上的 color-scheme 跟随主题
 * (见 hooks/useApplyTheme)。彻底自定义需换自绘下拉组件,暂不做。
 */
export const selectChrome = css({
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%237C7C7C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.625rem center',
  backgroundColor: 'greyscale.000',
  paddingRight: '2rem',
  '& option': {
    backgroundColor: 'greyscale.000',
    color: 'greyscale.900',
  },
})
