import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'wouter'
import {
  RiDashboardLine,
  RiGovernmentLine,
  RiTeamLine,
  RiFileList3Line,
  RiBuilding2Line,
  RiArrowLeftLine,
  type RemixiconComponentType,
} from '@remixicon/react'

import { css } from '@/styled-system/css'

import { useAdminMe } from '../hooks/useAdminMe'

interface NavItem {
  /** Path relative to the /admin base (wouter nested routing). */
  to: string
  labelKey: string
  Icon: RemixiconComponentType
}

const NAV: NavItem[] = [
  { to: '/', labelKey: 'shell.nav.dashboard', Icon: RiDashboardLine },
  { to: '/org', labelKey: 'shell.nav.org', Icon: RiGovernmentLine },
  { to: '/members', labelKey: 'shell.nav.members', Icon: RiTeamLine },
  {
    to: '/meeting-rooms',
    labelKey: 'shell.nav.meetingRooms',
    Icon: RiBuilding2Line,
  },
  { to: '/audit', labelKey: 'shell.nav.audit', Icon: RiFileList3Line },
]

/**
 * The M 端 chrome: a fixed left rail (console nav) + top bar (current org, exit
 * back to the C 端 workspace). Deliberately independent from the C 端 `Layout` /
 * `AppRail` so the console has its own navigation space and can be lifted into a
 * standalone app later with no C 端 coupling.
 */
export const AdminShell = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation('admin')
  const { data: me } = useAdminMe()
  const [location] = useLocation()

  const isActive = (to: string) =>
    to === '/' ? location === '/' : location.startsWith(to)

  return (
    <div
      className={css({
        display: 'flex',
        height: '100%',
        backgroundColor: 'greyscale.000',
        color: 'default.text',
      })}
    >
      <nav
        className={css({
          flexShrink: 0,
          width: '220px',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid token(colors.greyscale.200)',
          backgroundColor: 'greyscale.50',
        })}
      >
        <div
          className={css({
            paddingX: '1rem',
            paddingY: '1rem',
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
            borderBottom: '1px solid token(colors.greyscale.200)',
          })}
        >
          {t('shell.title')}
        </div>
        <div className={css({ flex: 1, overflowY: 'auto', paddingY: '0.5rem' })}>
          {NAV.map(({ to, labelKey, Icon }) => (
            <Link
              key={to}
              href={to}
              className={navLink(isActive(to))}
            >
              <Icon size={18} />
              <span>{t(labelKey)}</span>
            </Link>
          ))}
        </div>
        <a href="/" className={navLink(false)}>
          <RiArrowLeftLine size={18} />
          <span>{t('shell.backToApp')}</span>
        </a>
      </nav>

      <div
        className={css({
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        })}
      >
        <header
          className={css({
            flexShrink: 0,
            height: '48px',
            display: 'flex',
            alignItems: 'center',
            paddingX: '1.25rem',
            borderBottom: '1px solid token(colors.greyscale.200)',
            fontSize: '0.875rem',
            color: 'greyscale.700',
          })}
        >
          {me?.organization?.name ?? ''}
        </header>
        <main
          className={css({
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          })}
        >
          {children}
        </main>
      </div>
    </div>
  )
}

const navLink = (active: boolean) =>
  css({
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    paddingX: '1rem',
    paddingY: '0.625rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    color: active ? 'primary.700' : 'greyscale.800',
    fontWeight: active ? '600' : undefined,
    backgroundColor: active ? 'primary.100' : 'transparent',
    _hover: { backgroundColor: active ? 'primary.100' : 'greyscale.100' },
  })
