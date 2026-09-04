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

export const taskNavigationActionButtonCss = css({
  backgroundColor: 'transparent!',
  boxShadow: 'none!',
  _hover: { backgroundColor: 'greyscale.200!' },
  _focus: { backgroundColor: 'greyscale.200!' },
  '&[data-pressed]': { backgroundColor: 'greyscale.200!' },
})
