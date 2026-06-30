import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { RiLogoutBoxRLine, RiCameraLine } from '@remixicon/react'
import { useLanguageLabels } from '@/i18n/useLanguageLabels'
import { Badge, Dialog, type DialogProps, Field, H, P } from '@/primitives'
import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { LoginButton } from '@/components/LoginButton'
import { AvatarUploadDialog } from './AvatarUploadDialog'

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
  const [avatarOpen, setAvatarOpen] = useState(false)
  const initial = (user?.full_name || user?.email || '?')
    .slice(0, 1)
    .toUpperCase()
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
          {/* 头像设置:点击头像/按钮打开裁剪上传弹窗。 */}
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.875rem',
              marginBottom: '0.75rem',
            })}
          >
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              aria-label={t('account.avatar.change')}
              className={css({
                position: 'relative',
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                overflow: 'hidden',
                flexShrink: 0,
                _hover: { '& [data-role=overlay]': { opacity: 1 } },
              })}
            >
              {user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className={css({
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  })}
                />
              ) : (
                <span
                  className={css({
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'primary.500',
                    color: 'white',
                    fontSize: '1.5rem',
                  })}
                >
                  {initial}
                </span>
              )}
              <span
                data-role="overlay"
                className={css({
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(0,0,0,0.4)',
                  color: 'white',
                  opacity: 0,
                  transition: 'opacity 0.15s',
                })}
              >
                <RiCameraLine size={20} />
              </span>
            </button>
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              className={css({
                border: '1px solid token(colors.greyscale.300)',
                borderRadius: '0.5rem',
                backgroundColor: 'white',
                paddingX: '0.875rem',
                paddingY: '0.4375rem',
                fontSize: '0.875rem',
                cursor: 'pointer',
                color: 'greyscale.800',
                _hover: { backgroundColor: 'greyscale.50' },
              })}
            >
              {t('account.avatar.change')}
            </button>
          </div>
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
      {avatarOpen && (
        <AvatarUploadDialog onClose={() => setAvatarOpen(false)} />
      )}
    </Dialog>
  )
}
