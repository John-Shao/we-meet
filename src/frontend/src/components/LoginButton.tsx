import { Button } from '@/primitives'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/api/useConfig'
import { ProConnectButton } from './ProConnectButton'
import { authUrl } from '@/features/auth'

type LoginButtonProps = {
  proConnectHint?: boolean // Hide hint in layouts where space doesn't allow it.
}

export const LoginButton = ({ proConnectHint = true }: LoginButtonProps) => {
  const { t } = useTranslation('global', { keyPrefix: 'login' })
  const { data } = useConfig()

  // Upstream LaSuite (ProConnect) deployments keep the OIDC redirect.
  if (data?.use_proconnect_button) {
    return <ProConnectButton hint={proConnectHint} />
  }

  // we-meet: Keycloak 现在带 phone-auth 插件（手机号 OTP 登录页 = phone-browser
  // flow），OIDC 页不再是 dead end。web 登录走 OIDC 重定向以建立 Keycloak SSO 会话，
  // 从而 meet / docs / 未来子系统一次登录、跨系统免登（上游/main 亦走 OIDC）。
  // 自绘的手机号 OTP + 扫码 modal（LoginDialog）保留给移动端 App（Token Exchange，
  // 不需浏览器会话），web 不再从这里触发。
  return (
    <Button
      data-attr="login"
      variant="primary"
      onPress={() => {
        window.location.href = authUrl()
      }}
    >
      {t('buttonLabel')}
    </Button>
  )
}
