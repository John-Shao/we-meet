import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSnapshot } from 'valtio'
import {
  RiCloseLine,
  RiComputerLine,
  RiFileList3Line,
  RiMoonLine,
  RiSettings3Line,
  RiSunLine,
  RiUser3Line,
} from '@remixicon/react'
import type { RemixiconComponentType } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { useLanguageLabels } from '@/i18n/useLanguageLabels'
import { type DialogProps } from '@/primitives'
import { useUser } from '@/features/auth'
import { LoginButton } from '@/components/LoginButton'
import { Modal } from '@/components/Modal'
import { routes } from '@/routes'
import { themeStore, type ThemeMode } from '@/stores/theme'
import { AvatarUploadDialog } from './AvatarUploadDialog'

export type SettingsDialogProps = Pick<DialogProps, 'isOpen' | 'onOpenChange'>

type Section = 'general' | 'account' | 'agreement'

export const SettingsDialog = ({ isOpen, onOpenChange }: SettingsDialogProps) => {
  const { t } = useTranslation('settings')
  const { isLoggedIn } = useUser()
  const [section, setSection] = useState<Section>('general')
  const [avatarOpen, setAvatarOpen] = useState(false)

  if (!isOpen) return null

  const navItems: Array<{ key: Section; label: string; Icon: RemixiconComponentType }> =
    [
      { key: 'general', label: t('systemSettings.nav.general'), Icon: RiSettings3Line },
      { key: 'account', label: t('systemSettings.nav.account'), Icon: RiUser3Line },
      {
        key: 'agreement',
        label: t('systemSettings.nav.agreement'),
        Icon: RiFileList3Line,
      },
    ]

  return (
    <Modal
      onClose={() => onOpenChange?.(false)}
      ariaLabel={t('systemSettings.heading')}
      maxWidth="760px"
      maxHeight="560px"
    >
      <div className={headerCls}>
        <h2 className={headerTitleCls}>{t('systemSettings.heading')}</h2>
        <button
          type="button"
          onClick={() => onOpenChange?.(false)}
          aria-label={t('account.avatar.cancel')}
          className={closeCls}
        >
          <RiCloseLine size={20} />
        </button>
      </div>

      <div className={bodyCls}>
        <nav className={navCls}>
          {navItems.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              aria-current={section === key}
              className={cx(navItemCls, section === key && navItemActiveCls)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className={panelCls}>
          {section === 'general' && <GeneralPanel />}
          {section === 'account' && (
            <AccountPanel
              isLoggedIn={!!isLoggedIn}
              onEditAvatar={() => setAvatarOpen(true)}
            />
          )}
          {section === 'agreement' && <AgreementPanel />}
        </section>
      </div>

      {avatarOpen && <AvatarUploadDialog onClose={() => setAvatarOpen(false)} />}
    </Modal>
  )
}

/* ─── 通用设置:主题 + 语言 ─────────────────────────────────────────── */
const GeneralPanel = () => {
  const { t } = useTranslation('settings')
  const { mode } = useSnapshot(themeStore)
  const { languagesList, currentLanguage } = useLanguageLabels()
  const { i18n } = useTranslation()

  const themes: Array<{ key: ThemeMode; label: string; Icon: RemixiconComponentType }> =
    [
      { key: 'light', label: t('systemSettings.theme.light'), Icon: RiSunLine },
      { key: 'dark', label: t('systemSettings.theme.dark'), Icon: RiMoonLine },
      { key: 'system', label: t('systemSettings.theme.system'), Icon: RiComputerLine },
    ]

  return (
    <>
      <div className={fieldLabelCls}>{t('systemSettings.theme.heading')}</div>
      <div className={themeGridCls}>
        {themes.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              themeStore.mode = key
            }}
            aria-pressed={mode === key}
            className={cx(themeCardCls, mode === key && themeCardActiveCls)}
          >
            <Icon size={22} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className={rowCls}>
        <span className={fieldLabelCls}>{t('language.heading')}</span>
        <select
          value={currentLanguage.key}
          onChange={(e) => void i18n.changeLanguage(e.target.value)}
          aria-label={t('language.label')}
          className={selectCls}
        >
          {languagesList.map((l) => (
            <option key={l.key} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

/* ─── 账号管理:头像 + 用户名 + 邮箱(只放已有字段)───────────────────── */
const AccountPanel = ({
  isLoggedIn,
  onEditAvatar,
}: {
  isLoggedIn: boolean
  onEditAvatar: () => void
}) => {
  const { t } = useTranslation('settings')
  const { user } = useUser()

  if (!isLoggedIn) {
    return (
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '0.75rem' })}>
        <p className={css({ color: 'greyscale.700' })}>
          {t('account.youAreNotLoggedIn')}
        </p>
        <LoginButton />
      </div>
    )
  }

  const initial = (user?.full_name || user?.email || '?').slice(0, 1).toUpperCase()

  return (
    <div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('systemSettings.account.avatar')}</span>
        <button
          type="button"
          onClick={onEditAvatar}
          aria-label={t('account.avatar.change')}
          className={avatarBtnCls}
        >
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className={avatarImgCls} />
          ) : (
            <span className={avatarFallbackCls}>{initial}</span>
          )}
        </button>
      </div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('systemSettings.account.username')}</span>
        <span className={infoValCls}>
          {user?.full_name || t('systemSettings.account.notSet')}
        </span>
      </div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('systemSettings.account.email')}</span>
        <span className={infoValCls}>
          {user?.email || t('systemSettings.account.notSet')}
        </span>
      </div>
    </div>
  )
}

/* ─── 服务协议:用户协议 + 隐私政策 ─────────────────────────────────── */
const AgreementPanel = () => {
  const { t } = useTranslation('settings')
  const links: Array<{ label: string; href: string }> = [
    { label: t('systemSettings.agreement.userAgreement'), href: routes.termsOfService.path as string },
    { label: t('systemSettings.agreement.privacy'), href: routes.legalTerms.path as string },
  ]
  return (
    <div>
      {links.map((l) => (
        <div key={l.href} className={infoRowCls}>
          <span className={infoValCls}>{l.label}</span>
          <a href={l.href} target="_blank" rel="noopener noreferrer" className={viewBtnCls}>
            {t('systemSettings.agreement.view')}
          </a>
        </div>
      ))}
    </div>
  )
}

/* ─── styles ────────────────────────────────────────────────────────── */
const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1.5rem',
  paddingY: '1rem',
})
const headerTitleCls = css({
  margin: 0,
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.1000',
})
const closeCls = css({
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.600',
  display: 'inline-flex',
  _hover: { color: 'greyscale.900' },
})
const bodyCls = css({
  display: 'flex',
  flex: 1,
  minHeight: '22rem',
  overflow: 'hidden',
})
const navCls = css({
  flexShrink: 0,
  width: '11rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.5rem 0.75rem',
})
const navItemCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: 'none',
  borderRadius: '0.5rem',
  background: 'transparent',
  color: 'greyscale.800',
  fontSize: '0.9375rem',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
const navItemActiveCls = css({
  backgroundColor: 'greyscale.100',
  fontWeight: 'medium',
})
const panelCls = css({
  flex: 1,
  minWidth: 0,
  padding: '1.25rem 1.5rem',
  overflowY: 'auto',
})
const fieldLabelCls = css({
  fontSize: '0.9375rem',
  color: 'greyscale.900',
  marginBottom: '0.625rem',
})
const themeGridCls = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '0.75rem',
  marginBottom: '1.5rem',
})
const themeCardCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  paddingY: '1.25rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.625rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.800',
  fontSize: '0.875rem',
  cursor: 'pointer',
  _hover: { borderColor: 'primary.400' },
})
const themeCardActiveCls = css({
  borderColor: 'primary.500',
  backgroundColor: 'primary.50',
  color: 'primary.700',
})
const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
})
const selectCls = css({
  minWidth: '10rem',
  paddingX: '0.875rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.900',
  fontSize: '0.875rem',
  cursor: 'pointer',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})
const infoRowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingY: '1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const infoKeyCls = css({ fontSize: '0.9375rem', color: 'greyscale.800' })
const infoValCls = css({ fontSize: '0.9375rem', color: 'greyscale.900' })
const avatarBtnCls = css({
  width: '2.5rem',
  height: '2.5rem',
  borderRadius: '0.5rem',
  border: 'none',
  padding: 0,
  overflow: 'hidden',
  cursor: 'pointer',
  flexShrink: 0,
})
const avatarImgCls = css({ width: '100%', height: '100%', objectFit: 'cover' })
const avatarFallbackCls = css({
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'primary.500',
  color: 'white',
  fontSize: '1rem',
})
const viewBtnCls = css({
  paddingX: '1.25rem',
  paddingY: '0.4375rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.800',
  fontSize: '0.875rem',
  textDecoration: 'none',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
