import { H, Text, Icon } from '@/primitives'
import { css } from '@/styled-system/css'
import { LoginButton } from '@/components/LoginButton'
import { HStack } from '@/styled-system/jsx'

interface LoginPromptProps {
  heading: string
  body: string
}

export const LoginPrompt = ({ heading, body }: LoginPromptProps) => {
  return (
    <div
      className={css({
        // 内部 <H>/<Text> 继承 default.text(深色下为白),底色必须一起翻,
        // 否则整块提示是白字压浅蓝。
        backgroundColor: 'brand.50',
        borderRadius: '5px',
        border: '1px solid',
        borderColor: 'brand.200',
        paddingY: '1rem',
        paddingX: '1rem',
        marginTop: '1rem',
        display: 'flex',
        flexDirection: 'column',
      })}
    >
      <HStack justify="start" alignItems="center" marginBottom="0.5rem">
        <Icon type="symbols" name="login" />
        <H lvl={3} margin={false} padding={false}>
          {heading}
        </H>
      </HStack>
      <Text variant="smNote" wrap="pretty">
        {body}
      </Text>
      <div
        className={css({
          marginTop: '1rem',
        })}
      >
        <LoginButton proConnectHint={false} />
      </div>
    </div>
  )
}
