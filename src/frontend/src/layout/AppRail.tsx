import { Link, useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiMessage3Line,
  RiVidiconLine,
  RiCalendarLine,
  RiCheckboxCircleLine,
  RiContactsBookLine,
  RiFileTextLine,
  RiLogoutBoxRLine,
  type RemixiconComponentType,
} from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { useConfig } from '@/api/useConfig'
import { SettingsButton } from '@/features/settings'

/**
 * P6 global primary navigation rail (Feishu-style workspace shell, column 1).
 * Rendered by Layout for logged-in workspace routes; the in-call room stays
 * full-screen (no rail). Module secondary panels + main content are the route's
 * own job — see docs/phases/p6-ux-shell.md.
 */

interface NavItem {
  to: string
  labelKey: string
  Icon: RemixiconComponentType
}

const NAV: NavItem[] = [
  { to: '/im', labelKey: 'nav.messages', Icon: RiMessage3Line },
  { to: '/', labelKey: 'nav.meeting', Icon: RiVidiconLine },
  { to: '/calendar', labelKey: 'nav.calendar', Icon: RiCalendarLine },
  { to: '/approval', labelKey: 'nav.approval', Icon: RiCheckboxCircleLine },
  { to: '/contacts', labelKey: 'nav.contacts', Icon: RiContactsBookLine },
]

const itemBase = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '8px',
  fontSize: '0.875rem',
  color: 'greyscale.700',
  cursor: 'pointer',
  textDecoration: 'none',
  border: 'none',
  backgroundColor: 'transparent',
  textAlign: 'left',
  width: '100%',
  _hover: { backgroundColor: 'greyscale.100' },
})
const itemActive = css({
  backgroundColor: 'primary.100',
  color: 'primary.600',
  fontWeight: '500',
})

export const AppRail = () => {
  const { t } = useTranslation('shell')
  const { user, logout } = useUser()
  const { data: config } = useConfig()
  const [location] = useLocation()
  const docsUrl = config?.docs?.url
  const initial = (user?.full_name || user?.email || '?').slice(0, 1).toUpperCase()

  return (
    <nav
      aria-label={t('railLabel')}
      className={css({
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        // 飞书式一级导航栏底色(比白色内容区略带蓝灰,拉开层次)。
        backgroundColor: '#DEE4F5',
        borderRight: '1px solid token(colors.greyscale.200)',
        paddingY: '0.75rem',
        paddingX: '0.5rem',
      })}
    >
      <img
        src="/assets/logo.svg"
        alt={import.meta.env.VITE_APP_TITLE ?? ''}
        className={css({
          height: '32px',
          objectFit: 'contain',
          objectPosition: 'left',
          marginBottom: '0.75rem',
          paddingX: '0.25rem',
        })}
      />

      <div className={css({ display: 'flex', flexDirection: 'column', gap: '0.125rem' })}>
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            data-testid={`rail-${item.to}`}
            className={cx(itemBase, location === item.to ? itemActive : undefined)}
          >
            <item.Icon size={18} />
            <span>{t(item.labelKey)}</span>
          </Link>
        ))}
        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={itemBase}
          >
            <RiFileTextLine size={18} />
            <span>{t('nav.docs')}</span>
          </a>
        )}
      </div>

      <div
        className={css({
          marginTop: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
          paddingTop: '0.5rem',
          borderTop: '1px solid token(colors.greyscale.100)',
        })}
      >
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            paddingX: '0.5rem',
            paddingY: '0.375rem',
            minWidth: 0,
          })}
        >
          <span
            className={css({
              width: '28px',
              height: '28px',
              borderRadius: 'full',
              backgroundColor: 'primary.500',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              flexShrink: 0,
            })}
          >
            {initial}
          </span>
          <span
            className={css({
              flexGrow: 1,
              minWidth: 0,
              fontSize: '0.8125rem',
              color: 'greyscale.700',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })}
          >
            {user?.full_name || user?.email}
          </span>
          <SettingsButton />
        </div>
        <button type="button" onClick={() => logout()} className={itemBase}>
          <RiLogoutBoxRLine size={18} />
          <span>{t('logout')}</span>
        </button>
      </div>
    </nav>
  )
}
