import { styled } from '@/styled-system/jsx'
import { Text, TextProps } from 'react-aria-components'

const StyledDescription = styled(Text, {
  base: {
    display: 'block',
    textStyle: 'sm',
    color: 'text.secondary',
    marginBottom: 0.125,
  },
})

/**
 * Styled field description.
 *
 * Used internally by Fields.
 */
export const FieldDescription = (props: TextProps) => {
  return <StyledDescription {...props} />
}
