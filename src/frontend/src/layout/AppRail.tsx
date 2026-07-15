import { useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  Button as RACButton,
  Menu as RACMenu,
  MenuItem,
} from 'react-aria-components'
import {
  RiMessage3Line,
  RiVidiconLine,
  RiCalendarLine,
  RiCheckboxCircleLine,
  RiContactsBookLine,
  RiFileTextLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiMoreLine,
  RiSettings3Line,
  RiLogoutBoxRLine,
  type RemixiconComponentType,
} from '@remixicon/react'
import { useQuery } from '@tanstack/react-query'

import { css, cx } from '@/styled-system/css'
import { Menu } from '@/primitives/Menu'
import { useUser } from '@/features/auth'
import { useConfig } from '@/api/useConfig'
import { SettingsDialog } from '@/features/settings/components/SettingsDialog'
import { useImUnread } from '@/features/im/components/ImUnreadProvider'
import { fetchApprovals } from '@/features/approval/api/fetchApproval'
import { GlobalSearch } from './GlobalSearch'

/**
 * P6 global primary navigation rail — DeepSeek-style light shell (column 1).
 * Top: logo + search + collapse. Middle: module nav (grey selection). Bottom:
 * user avatar + name + a "⋯ more" menu (系统设置 / 退出登录). Rendered by Layout
 * for logged-in workspace routes; the in-call room stays full-screen (no rail).
 */

interface NavItem {
  to: string
  labelKey: string
  Icon: RemixiconComponentType
}

const NAV: NavItem[] = [
  { to: '/im', labelKey: 'nav.messages', Icon: RiMessage3Line },
  { to: '/meeting', labelKey: 'nav.meeting', Icon: RiVidiconLine },
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
  borderRadius: '10px',
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
  backgroundColor: 'greyscale.200',
  color: 'greyscale.900',
  fontWeight: '600',
})
const itemCollapsed = css({ justifyContent: 'center', paddingX: '0.5rem' })

const iconButton = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '36px',
  height: '36px',
  border: 'none',
  borderRadius: '8px',
  backgroundColor: 'transparent',
  color: 'greyscale.700',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})

// The Menu primitive's Popover already provides the surface chrome; this just
// sizes the list and removes the focus outline.
const menuList = css({
  minWidth: '160px',
  outline: 'none',
})
const menuItemCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  borderRadius: '8px',
  fontSize: '0.875rem',
  color: 'greyscale.800',
  cursor: 'pointer',
  outline: 'none',
  _hover: { backgroundColor: 'greyscale.100' },
})

interface Props {
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export const AppRail = ({ collapsed = false, onToggleCollapse }: Props) => {
  const { t } = useTranslation('shell')
  const { user, logout } = useUser()
  const { data: config } = useConfig()
  const [location] = useLocation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const docsUrl = config?.docs?.url
  const initial = (user?.full_name || user?.email || '?').slice(0, 1).toUpperCase()
  const displayName = user?.full_name || user?.email || ''

  // Rail unread badges: messages from the global IM presence, approvals from the
  // shared pending query (same cache the approval module uses).
  const { messages: unreadMessages } = useImUnread()
  const { data: pendingApprovals = [] } = useQuery({
    queryKey: ['approval', 'pending'],
    queryFn: () => fetchApprovals('pending'),
    staleTime: 30_000,
    // Always-on rail badge: degrade silently if the endpoint errors (e.g. 500)
    // instead of retry-storming + refetching on every window focus.
    retry: false,
    refetchOnWindowFocus: false,
  })
  const badgeFor = (to: string): number =>
    to === '/im' ? unreadMessages : to === '/approval' ? pendingApprovals.length : 0

  const avatarNode = user?.avatar_url ? (
    <img
      src={user.avatar_url}
      alt=""
      className={css({
        width: '32px',
        height: '32px',
        borderRadius: '7px',
        objectFit: 'cover',
        flexShrink: 0,
      })}
    />
  ) : (
    <span
      className={css({
        width: '32px',
        height: '32px',
        borderRadius: '7px',
        backgroundColor: 'primary.500',
        color: 'white',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '0.8125rem',
        flexShrink: 0,
      })}
    >
      {initial}
    </span>
  )

  const moreMenuItems = (
    <RACMenu className={menuList}>
      <MenuItem onAction={() => setSettingsOpen(true)} className={menuItemCls}>
        <RiSettings3Line size={16} />
        {t('settingsButtonLabel', { ns: 'settings' })}
      </MenuItem>
      <MenuItem onAction={() => logout()} className={menuItemCls}>
        <RiLogoutBoxRLine size={16} />
        {t('logout')}
      </MenuItem>
    </RACMenu>
  )

  return (
    <nav
      aria-label={t('railLabel')}
      className={css({
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'railBg',
        borderRight: '1px solid token(colors.greyscale.200)',
        paddingY: '0.75rem',
        paddingX: '0.5rem',
      })}
    >
      {/* 顶部:logo + 搜索 + 收起导航栏。 */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginBottom: '0.75rem',
          paddingX: '0.25rem',
          justifyContent: collapsed ? 'center' : 'space-between',
          flexDirection: collapsed ? 'column' : 'row',
        })}
      >
        {!collapsed && (
          <img
            src="/assets/logo.svg"
            alt=""
            className={css({
              height: '28px',
              // 窄轨(可拖到 180px)时让 logo 收缩/左裁,而不是把右侧按钮组顶出界。
              minWidth: 0,
              flexShrink: 1,
              maxWidth: '100%',
              objectFit: 'contain',
              objectPosition: 'left',
            })}
          />
        )}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.125rem',
            flexShrink: 0,
            flexDirection: collapsed ? 'column' : 'row',
          })}
        >
          <GlobalSearch collapsed />
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? t('expand') : t('collapse')}
            title={collapsed ? t('expand') : t('collapse')}
            data-testid="rail-collapse-toggle"
            className={iconButton}
          >
            {collapsed ? (
              <RiArrowRightSLine size={18} />
            ) : (
              <RiArrowLeftSLine size={18} />
            )}
          </button>
        </div>
      </div>

      {/* 模块导航。 */}
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '0.125rem' })}>
        {NAV.map((item) => {
          const badge = badgeFor(item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              data-testid={`rail-${item.to}`}
              title={collapsed ? t(item.labelKey) : undefined}
              className={cx(
                itemBase,
                location === item.to ? itemActive : undefined,
                collapsed ? itemCollapsed : undefined
              )}
            >
              <span
                className={css({ position: 'relative', display: 'flex', flexShrink: 0 })}
              >
                <item.Icon size={18} />
                {collapsed && badge > 0 && (
                  <span
                    className={css({
                      position: 'absolute',
                      top: '-2px',
                      right: '-3px',
                      width: '8px',
                      height: '8px',
                      borderRadius: '999px',
                      backgroundColor: 'danger.500',
                      border: '1.5px solid',
                      borderColor: 'railBg',
                    })}
                  />
                )}
              </span>
              {!collapsed && (
                <>
                  <span className={css({ flex: 1 })}>{t(item.labelKey)}</span>
                  {badge > 0 && (
                    <span
                      className={css({
                        minWidth: '18px',
                        height: '18px',
                        paddingX: '0.25rem',
                        borderRadius: '999px',
                        backgroundColor: 'danger.500',
                        color: 'white',
                        fontSize: '0.6875rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      })}
                    >
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </>
              )}
            </Link>
          )
        })}
        {docsUrl && (
          <Link
            to="/docs"
            data-testid="rail-/docs"
            title={collapsed ? t('nav.docs') : undefined}
            className={cx(
              itemBase,
              location === '/docs' ? itemActive : undefined,
              collapsed ? itemCollapsed : undefined
            )}
          >
            <RiFileTextLine size={18} />
            {!collapsed && <span>{t('nav.docs')}</span>}
          </Link>
        )}
      </div>

      {/* 底部:头像 + 名字 + 更多菜单(系统设置 / 退出登录)。 */}
      <div
        className={css({
          marginTop: 'auto',
          paddingTop: '0.5rem',
          borderTop: '1px solid token(colors.greyscale.100)',
        })}
      >
        {collapsed ? (
          <div className={css({ display: 'flex', justifyContent: 'center' })}>
            <Menu placement="right">
              <RACButton
                aria-label={`${displayName} · ${t('more')}`}
                className={css({
                  border: 'none',
                  background: 'transparent',
                  padding: '0.25rem',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                {avatarNode}
              </RACButton>
              {moreMenuItems}
            </Menu>
          </div>
        ) : (
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              paddingX: '0.25rem',
              paddingY: '0.25rem',
              borderRadius: '10px',
              _hover: { backgroundColor: 'greyscale.100' },
            })}
          >
            {avatarNode}
            <span
              className={css({
                flex: 1,
                minWidth: 0,
                fontSize: '0.875rem',
                fontWeight: '500',
                color: 'greyscale.900',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              {displayName}
            </span>
            <Menu placement="top">
              <RACButton aria-label={t('more')} className={iconButton}>
                <RiMoreLine size={18} />
              </RACButton>
              {moreMenuItems}
            </Menu>
          </div>
        )}
      </div>

      <SettingsDialog isOpen={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  )
}
