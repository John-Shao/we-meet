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
  // 原自绘手机号 OTP modal 已移除（由 Keycloak phone-authenticator 取代）；扫码登录
  // 组件（QrLoginPanel/qrLogin）暂留，待后续接入 KC 认证流做二维码 SSO。
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
