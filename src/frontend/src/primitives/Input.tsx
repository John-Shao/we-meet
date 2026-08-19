import { styled } from '@/styled-system/jsx'
import { Input as RACInput } from 'react-aria-components'

/**
 * Styled RAC Input.
 *
 * Used internally by Fields.
 *
 * 焦点态**不在这里**:输入类控件的「蓝描边 + 柔光环」由 styles/index.css 的
 * 「统一焦点描边」①统一给出(原生 input 元素一律命中),所以这里不写 `_focus`,
 * 也别再写 —— 那条规则未分层,普通声明盖不住它。同理,下面这条 `transition: all`
 * 里的 border-color / box-shadow 两项也由那边接管(120ms)。
 */
export const Input = styled(RACInput, {
  base: {
    width: 'full',
    // 钉死表单默认高度,与 Select / Button sm 对齐(见 panda.config 的
    // sizes.control)。原先靠 padding + 继承行高算出 34px,而 Select 是 30px,
    // 同一行放一起差 4px。单行 input 的文字由浏览器垂直居中,不受影响。
    height: 'control.md',
    minHeight: 'control.md',
    paddingY: 0.25,
    paddingX: 0.5,
    border: '1px solid',
    borderColor: 'control.border',
    color: 'control.text',
    borderRadius: 4,
    transition: 'all token(durations.slow)',
  },
})
