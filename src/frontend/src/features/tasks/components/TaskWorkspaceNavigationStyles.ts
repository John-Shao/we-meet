import { css, cva } from '@/styled-system/css'

export const taskNavigationMenuCss = css({
  minWidth: '10rem',
  fontSize: '0.875rem',
})

export const taskNavigationMenuItemLabelCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
})

export const taskNavigationActionsCss = cva({
  base: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '0.125rem',
  },
  variants: {
    visibility: {
      conditional: {
        opacity: 0,
        pointerEvents: 'none',
        transition: 'opacity 120ms ease',
        '&:has(:focus-visible)': { opacity: 1, pointerEvents: 'auto' },
      },
      persistent: {},
    },
  },
  defaultVariants: { visibility: 'conditional' },
})

/**
 * 二级导航栏里的纯图标钮:只补一件基元补不了的事 —— **这个面上的可见 hover**。
 *
 * 为什么必须留一条覆盖:基元 `IconButton`(`quaternaryText`)的 hover 底色是
 * `surface.canvas`,而本栏底色 `subNavBg` 就是 `greyscale.50` —— 浅色下两边同为
 * `#F6F6F6`,悬停完全看不出来。组件系统「状态矩阵」里 hover 是 Web 必填项,所以这里
 * 显式换成高一档的 `surface.muted`(`#EEEEEE`;深色 `#242424`),两套主题都可见。
 * pressed 不覆盖,留给基元的选中态观感(浅蓝底 + 品牌蓝图,瞬时态)。
 *
 * 此前这里写的是 `backgroundColor: transparent!` —— 那是在按掉
 * `variant="tertiary"` 带进来的**选中态**浅蓝底,但只按了底色、没按图标色,于是导航里
 * 的「＋ / ⋯ / 齿轮」一直是品牌蓝 `action.selected.text`。换成基元之后底色本就透明,
 * 这条覆盖连同 `boxShadow: none!` 一起删掉。
 */
export const taskNavigationActionButtonCss = css({
  _hover: { backgroundColor: 'surface.muted!' },
  _focus: { backgroundColor: 'surface.muted!' },
})
