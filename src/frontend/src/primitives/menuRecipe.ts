import { sva } from '@/styled-system/css'

export const menuRecipe = sva({
  slots: ['root', 'item'],
  base: {
    root: {},
    item: {
      paddingY: 0.125,
      paddingX: 0.5,
      textAlign: 'left',
      width: 'full',
      borderRadius: 'field',
      cursor: 'pointer',
      color: 'text.primary',
      border: '1px solid transparent',
      position: 'relative',
      '&[data-selected]': {
        '&::before': {
          content: '"✓"',
          position: 'absolute',
          top: '2px',
          left: '6px',
        },
      },
      '&[data-focused]': {
        color: 'text.primary!',
        backgroundColor: 'surface.canvas!',
        outline: 'none!',
      },
      '&[data-hovered]': {
        color: 'text.primary!',
        backgroundColor: 'surface.canvas!',
        outline: 'none!',
      },
      '&[data-pressed]': {
        backgroundColor: 'action.selected.bg!',
      },
      '&[data-focus-visible]': {
        outline: '2px solid token(colors.border.focus)!',
        outlineOffset: '-2px',
      },
      '&[data-disabled]': {
        color: 'text.disabled!',
        cursor: 'default',
      },
    },
  },
  variants: {
    variant: {
      light: {},
      dark: {
        item: {
          color: 'white',
        },
      },
    },
    extraPadding: {
      true: {
        item: {
          paddingLeft: 1.5,
        },
      },
    },
    icon: {
      true: {
        item: {
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          paddingY: '0.4rem',
        },
      },
    },
  },
  defaultVariants: {
    variant: 'light',
  },
})
