import { styled } from '@/styled-system/jsx'
import { Input as RACInput } from 'react-aria-components'

/**
 * Styled RAC Input.
 *
 * Used internally by Fields.
 */
export const Input = styled(RACInput, {
  base: {
    width: 'full',
    // 钉死表单默认高度,与 Select / Button sm 对齐(见 panda.config 的
    // sizes.control)。原先靠 padding + 继承行高算出 34px,而 Select 是 30px,
    // 同一行放一起差 4px。单行 input 的文字由浏览器垂直居中,不受影响。
    height: 'control.md',
    paddingY: 0.25,
    paddingX: 0.5,
    border: '1px solid',
    borderColor: 'control.border',
    color: 'control.text',
    borderRadius: 4,
    transition: 'all token(durations.slow)',
  },
})
