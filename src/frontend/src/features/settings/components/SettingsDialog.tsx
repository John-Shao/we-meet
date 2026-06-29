import { Trans, useTranslation } from 'react-i18next'
import { RiLogoutBoxRLine } from '@remixicon/react'
import { useLanguageLabels } from '@/i18n/useLanguageLabels'
import { Badge, Dialog, type DialogProps, Field, H, P } from '@/primitives'
import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { LoginButton } from '@/components/LoginButton'

// 与(已移除的)一级导航栏退出按钮同款:图标 + 文字 + hover 高亮。
const logoutButton = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  width: 'fit-content',
  marginTop: '0.5rem',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '8px',
  fontSize: '0.875rem',
  color: 'greyscale.700',
  cursor: 'pointer',
  border: 'none',
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'greyscale.100' },
})

export type SettingsDialogProps = Pick<DialogProps, 'isOpen' | 'onOpenChange'>

export const SettingsDialog = (props: SettingsDialogProps) => {
  const { t, i18n } = useTranslation('settings')
  const { user, isLoggedIn, logout } = useUser()
  const { languagesList, currentLanguage } = useLanguageLabels()
  // OTP-registered users don't have an email (Keycloak account is created
  // from phone + firstName only), so the historical "name (email)" template
  // would render nothing. Fall back to whichever single field exists.
  const userDisplay =
    user?.full_name && user?.email
      ? `${user.full_name} (${user.email})`
      : user?.full_name || user?.email
  return (
    <Dialog title={t('dialog.heading')} {...props}>
      <H lvl={2}>{t('account.heading')}</H>
      {isLoggedIn ? (
        <>
          <P>
            <Trans
              i18nKey="settings:account.currentlyLoggedAs"
              values={{ user: userDisplay }}
              components={[<Badge />]}
            />
          </P>
        </>
      ) : (
        <>
          <P>{t('account.youAreNotLoggedIn')}</P>
          <LoginButton />
        </>
      )}
      <H lvl={2}>{t('language.heading')}</H>
      <Field
        type="select"
        label={t('language.label')}
        items={languagesList}
        defaultSelectedKey={currentLanguage.key}
        onSelectionChange={(lang) => {
          i18n.changeLanguage(lang as string)
        }}
      />
      {isLoggedIn && (
        <button type="button" onClick={logout} className={logoutButton}>
          <RiLogoutBoxRLine size={18} />
          <span>{t('logout', { ns: 'global' })}</span>
        </button>
      )}
    </Dialog>
  )
}
