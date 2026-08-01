import { cva } from '@/styled-system/css'
import { styled } from '@/styled-system/jsx'

const box = cva({
  base: {
    position: 'relative',
    gap: 'gutter',
    borderRadius: 8,
    padding: 'boxPadding',
    flex: 1,
  },
  variants: {
    type: {
      screen: {
        margin: 'auto',
        width: '38rem',
        maxWidth: '100%',
        textAlign: 'center',
        borderColor: 'transparent',
        paddingY: 0,
      },
      popover: {
        padding: 'boxPadding.xs',
        minWidth: '10rem',
        boxShadow: 'overlay',
      },
      dialog: {
        width: '30rem',
        maxWidth: '100%',
      },
      alert: {
        width: '24rem',
        maxWidth: '100%',
      },
    },
    variant: {
      light: {
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'box.border',
        backgroundColor: 'box.bg',
        color: 'box.text',
      },
      subtle: {
        color: 'default.subtle-text',
        backgroundColor: 'default.subtle',
      },
      control: {
        border: '1px solid {colors.control.border}',
        backgroundColor: 'box.bg',
        color: 'control.text',
      },
      // 会中控制栏的深色浮层(Menu/Popover/Select 的 variant="dark")。
      // 原先这里是 `borderColord`(拼错,非 CSS 属性,静默失效),且没有
      // borderWidth/borderStyle —— 于是浮层与身后的舞台同为 primaryDark.50、
      // 阴影 #0000001a 压在深底上又不可见,整块只能靠内容看出边界。
      // 补齐三件套并把边框调到 primaryDark.200,给它一条看得见的边。
      dark: {
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'primaryDark.200',
        backgroundColor: 'primaryDark.50',
      },
    },
    size: {
      default: {
        padding: 'boxPadding',
      },
      sm: {
        padding: 'boxPadding.sm',
      },
    },
  },
  defaultVariants: {
    variant: 'light',
    size: 'default',
  },
})

export const Box = styled('div', box)
