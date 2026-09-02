import {
  Switch as RACSwitch,
  SwitchProps as RACSwitchProps,
} from 'react-aria-components'
import { styled } from '@/styled-system/jsx'
import { StyledVariantProps } from '@/styled-system/types'

/**
 * 简洁版 iOS 风格开关:关=灰色实心轨道、开=蓝色实心轨道,白色圆点滑块带轻微
 * 阴影,轨道内不放勾/叉图标。轨道、标签和选中态全部使用公共语义角色；
 * 滑块在选中态使用 action.primary.text，确保两套主题都与主操作底色配对。
 */
export const StyledSwitch = styled(RACSwitch, {
  base: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.571rem',
    color: 'text.primary',
    cursor: 'pointer',
    forcedColorAdjust: 'none',
    '& .indicator': {
      position: 'relative',
      flexShrink: 0,
      width: '2.6rem',
      height: '1.5rem',
      borderRadius: 'full',
      // 关态:灰色实心轨道。
      background: 'border.default',
      transition: 'background-color token(durations.slow)',
      _before: {
        content: '""',
        display: 'block',
        position: 'absolute',
        top: '50%',
        left: '0.125rem',
        width: '1.25rem',
        height: '1.25rem',
        borderRadius: 'full',
        background: 'white',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
        transform: 'translateY(-50%)',
        transition: 'transform token(durations.slow)',
        willChange: 'transform',
      },
    },
    // 开态:蓝色实心轨道 + 滑块右移(2.6 - 1.25 - 0.125*2 = 1.1rem)。
    '&[data-selected] .indicator': {
      background: 'action.primary.bg',
      _before: {
        background: 'action.primary.text',
        transform: 'translateY(-50%) translateX(1.1rem)',
      },
    },
    '&[data-disabled]': {
      cursor: 'default',
      opacity: 0.5,
    },
    '&[data-focus-visible] .indicator': {
      outline: '2px solid!',
      outlineColor: 'border.focus!',
      outlineOffset: '2px!',
    },
  },
  variants: {},
})

export type SwitchProps = StyledVariantProps<typeof StyledSwitch> &
  RACSwitchProps

/**
 * Styled RAC Switch.
 */
export const Switch = ({ children, ...props }: SwitchProps) => (
  <StyledSwitch {...props}>
    {(renderProps) => (
      <>
        <div className="indicator" />
        {typeof children === 'function' ? children(renderProps) : children}
      </>
    )}
  </StyledSwitch>
)
