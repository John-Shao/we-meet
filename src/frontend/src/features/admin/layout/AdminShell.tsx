import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'wouter'
import {
  RiDashboardLine,
  RiGovernmentLine,
  RiFileList3Line,
  RiBuilding2Line,
  RiTeamLine,
  RiShieldKeyholeLine,
  RiArrowLeftLine,
  type RemixiconComponentType,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { useHasPermission } from '@/hooks/useOrgContext'

import { useAdminMe } from '../hooks/useAdminMe'

interface NavItem {
  /** Path relative to the /admin base (wouter nested routing). */
  to: string
  labelKey: string
  Icon: RemixiconComponentType
  /**
   * 看得见这一项需要的权限点(P10 M2)。持有 HR 角色的人看不到「角色与权限」。
   *
   * 只是**导航过滤**,不是权限本身 —— 真正的门在服务端每个端点上。这里少显示
   * 一项是为了别让人点进一个必定 403 的页面。
   */
  permission: string
}

interface NavGroup {
  /** null = 不带分组标题(概览这种单项)。 */
  labelKey: string | null
  items: NavItem[]
}

const NAV: NavGroup[] = [
  {
    labelKey: null,
    items: [
      {
        to: '/',
        labelKey: 'shell.nav.dashboard',
        Icon: RiDashboardLine,
        permission: 'org.stats.read',
      },
    ],
  },
  {
    labelKey: 'shell.navGroup.org',
    items: [
      // 成员与部门合成一项(页内四 tab):原来分成「组织架构」+「成员管理」两项,
      // 而调岗、看部门有谁、给部门设负责人全都要在两页之间来回跳。
      {
        to: '/org',
        labelKey: 'shell.nav.org',
        Icon: RiGovernmentLine,
        permission: 'org.member.read',
      },
      {
        to: '/groups',
        labelKey: 'shell.nav.groups',
        Icon: RiTeamLine,
        permission: 'org.group.read',
      },
      {
        to: '/roles',
        labelKey: 'shell.nav.roles',
        Icon: RiShieldKeyholeLine,
        permission: 'org.role.read',
      },
    ],
  },
  {
    labelKey: 'shell.navGroup.workplace',
    items: [
      {
        to: '/meeting-rooms',
        labelKey: 'shell.nav.meetingRooms',
        Icon: RiBuilding2Line,
        permission: 'org.meeting_room.write',
      },
    ],
  },
  {
    labelKey: 'shell.navGroup.governance',
    items: [
      {
        to: '/audit',
        labelKey: 'shell.nav.audit',
        Icon: RiFileList3Line,
        permission: 'org.audit.read',
      },
    ],
  },
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
  const has = useHasPermission()

  const isActive = (to: string) =>
    to === '/' ? location === '/' : location.startsWith(to)

  // 整组都没权限就连组标题一起不渲染 —— 一个空的「组织管理」标题比没有更费解。
  const visibleGroups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => has(item.permission)),
  })).filter((group) => group.items.length > 0)

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
          {visibleGroups.map((group, index) => (
            <div key={group.labelKey ?? `g${index}`}>
              {group.labelKey && (
                <div className={navGroupLabel}>{t(group.labelKey)}</div>
              )}
              {group.items.map(({ to, labelKey, Icon }) => (
                <Link key={to} href={to} className={navLink(isActive(to))}>
                  <Icon size={18} />
                  <span>{t(labelKey)}</span>
                </Link>
              ))}
            </div>
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

const navLinkBase = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '1rem',
  paddingY: '0.625rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
} as const

// 选中/未选中用两个完整类切换,不在一个 css() 里用 active 三元拼同一批属性:
// 悬停态尤其容易漏 —— 少写一个 _dark 下的 _hover,鼠标一放上去背景就跳回
// 固定色阶的浅蓝,配浅蓝文字直接看不见(实测反馈)。
const navLinkIdle = css({
  ...navLinkBase,
  color: 'greyscale.800',
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'greyscale.100' },
})

// selected.* 自带深浅两套,连 _hover 都不用再单独翻一遍 —— 之前正是漏了
// `_dark` 里的 `_hover`,鼠标一放上去底色就跳回固定浅蓝、配浅蓝字看不见。
const navLinkActive = css({
  ...navLinkBase,
  color: 'selected.text',
  fontWeight: '600',
  backgroundColor: 'selected.bg',
  _hover: { backgroundColor: 'selected.bg' },
})

const navLink = (active: boolean) => (active ? navLinkActive : navLinkIdle)

const navGroupLabel = css({
  paddingX: '1rem',
  paddingTop: '0.75rem',
  paddingBottom: '0.25rem',
  fontSize: '0.6875rem',
  fontWeight: '600',
  letterSpacing: '0.03em',
  color: 'greyscale.500',
  textTransform: 'uppercase',
})
