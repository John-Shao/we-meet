import { DialogTrigger } from 'react-aria-components'
import { Button } from '@/primitives'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/api/useConfig'
import { ProConnectButton } from './ProConnectButton'
import { LoginDialog } from '@/features/home/components/LoginDialog'

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

  // we-meet auth is phone-OTP + QR, so every login entry point (home,
  // header, settings, recording prompt) must open the same dialog instead
  // of redirecting to authUrl() — the legacy Keycloak OIDC page is a dead
  // end here.
  return (
    <DialogTrigger>
      <Button data-attr="login" variant="primary">
        {t('buttonLabel')}
      </Button>
      <LoginDialog />
    </DialogTrigger>
  )
}
