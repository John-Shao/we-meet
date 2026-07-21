import { css } from '@/styled-system/css'

/**
 * 原生 <select> 统一外观:隐藏系统默认箭头,换成中性灰(#7C7C7C =
 * greyscale.500,深浅色同值,两种主题都成立)自绘下拉箭头,并在右侧留位。
 * 只管「箭头 + 右内边距」这层 chrome,边框/圆角/底色仍由各处自身样式决定,
 * 故 cx(本地样式, selectChrome) 即可,不侵入布局。
 *
 * 注:原生 select 展开的选项列表仍由系统渲染,无法跨浏览器统一——这里只
 * 统一闭合态观感。彻底自定义需换成自绘下拉组件(工作量大,暂不做)。
 */
export const selectChrome = css({
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%237C7C7C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.625rem center',
  paddingRight: '2rem',
})
