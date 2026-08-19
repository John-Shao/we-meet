import { TextArea as RACTextArea } from 'react-aria-components'
import { styled } from '@/styled-system/jsx'

/**
 * Styled RAC TextArea.
 *
 * 焦点态同 Input:由 styles/index.css 的「统一焦点描边」①给出,不要在这里写
 * `_focus`(那条规则未分层,普通声明盖不住)。
 */
export const TextArea = styled(RACTextArea, {
  base: {
    width: 'full',
    paddingY: 0.25,
    paddingX: 0.5,
    border: '1px solid',
    borderColor: 'control.border',
    color: 'control.text',
    borderRadius: 4,
    transition: 'all token(durations.slow)',
  },
  variants: {
    placeholderStyle: {
      strong: {
        _placeholder: {
          color: 'greyscale.1000',
        },
      },
    },
  },
})
