import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiArrowLeftDoubleLine,
  RiGroupLine,
  RiHistoryLine,
  RiSearchLine,
  RiStarFill,
  RiStarLine,
  RiTeamLine,
  RiUserSharedLine,
} from '@remixicon/react'

import { css, cx } from '@/styled-system/css'

import type { DirectoryDepartment } from '../api/ApiDirectory'
import { DepartmentTree } from './DepartmentTree'

/**
 * 左栏的四态:'starred'(星标联系人)/ 'groups'(我的群组)/ 'external'(外部
 * 联系人)/ null(部门视图 —— 具体看哪个部门由 selectedDeptId 决定,全都为空
 * 时是「全部成员」)。
 */
export type ContactsView = 'starred' | 'groups' | 'external' | null

export interface ContactsSidebarCounts {
  starred: number
  groups: number
  /** 所有群的未读数之和 → 「我的群组」右侧的红标。 */
  groupUnread: number
  external: number
  /** 待我处理的外部联系人申请数 → 「外部联系人」右侧的红标。 */
  externalPending: number
  /** 全组织人数;未知(null)时这一行不显示数字。 */
  members: number | null
}

interface Props {
  view: ContactsView
  selectedDeptId: string | null
  departments: DirectoryDepartment[]
  /** 最近访问过的部门(已按 id 解析成部门对象,从 latest 到最早)。 */
  recent: DirectoryDepartment[]
  counts: ContactsSidebarCounts
  onSelectView: (view: Exclude<ContactsView, null>) => void
  onSelectAll: () => void
  onSelectDept: (id: string) => void
  /** 收起整栏(由路由持有状态并持久化)。 */
  onCollapse: () => void
}

/**
 * 通讯录左栏。
 *
 * 结构上做了一件之前没做的事:**分组**。以前「星标/我的群组/外部联系人/全部成员」
 * 和部门树是一个无标记的平铺列表,长相完全一样,可行为却分两类 —— 点前三个会换掉
 * 整个中栏,点部门只是换中栏的数据。栏头还写着「部门」,但里面一半不是部门。
 * 现在分成「常用」和「组织架构」两段:前者是入口(带计数与角标),后者是组织结构。
 *
 * 图标全部走 remixicon:以前用 ⭐/👥/◇ 三个 emoji 当图标,跨平台字形不一、不随主题,
 * 还会被读屏念成「white medium star 星标联系人」。
 */
export const ContactsSidebar = ({
  view,
  selectedDeptId,
  departments,
  recent,
  counts,
  onSelectView,
  onSelectAll,
  onSelectDept,
  onCollapse,
}: Props) => {
  const { t } = useTranslation('contacts')
  const [deptFilter, setDeptFilter] = useState('')

  return (
    <aside className={asideCls}>
      <div className={headerCls}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('page.title')}
        </h2>
        {/* 收起整栏:窄屏/只想看名单时把 260px 还给中栏。收起后中栏左侧留一条
            36px 的窄条,「展开」按钮就在那里,任何视图下都找得到。 */}
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t('page.hideNav')}
          title={t('page.hideNav')}
          data-testid="contacts-nav-collapse"
          className={collapseBtnCls}
        >
          <RiArrowLeftDoubleLine size={16} />
        </button>
      </div>

      {/* 部门筛选:几十个部门时按名字定位,不必手翻整棵树。 */}
      <label className={filterWrapCls}>
        <RiSearchLine size={14} aria-hidden className={filterIconCls} />
        <input
          type="search"
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          placeholder={t('page.filterDepartments')}
          aria-label={t('page.filterDepartments')}
          data-testid="contacts-dept-filter"
          className={filterInputCls}
        />
      </label>

      <nav>
        <h3 className={sectionCls}>{t('page.sectionFrequent')}</h3>
        <SidebarEntry
          icon={<RiStarLine size={16} />}
          activeIcon={<RiStarFill size={16} />}
          label={t('starred.title')}
          count={counts.starred}
          active={view === 'starred'}
          onClick={() => onSelectView('starred')}
          testId="contacts-starred-entry"
        />
        <SidebarEntry
          icon={<RiGroupLine size={16} />}
          label={t('groups.title')}
          count={counts.groups}
          badge={counts.groupUnread}
          badgeLabel={t('page.unreadBadge', { count: counts.groupUnread })}
          active={view === 'groups'}
          onClick={() => onSelectView('groups')}
          testId="contacts-groups-entry"
        />
        <SidebarEntry
          icon={<RiUserSharedLine size={16} />}
          label={t('external.title')}
          count={counts.external}
          badge={counts.externalPending}
          badgeLabel={t('external.pendingBadge', {
            count: counts.externalPending,
          })}
          badgeTestId="contacts-external-pending"
          active={view === 'external'}
          onClick={() => onSelectView('external')}
          testId="contacts-external-entry"
        />

        {/* 最近访问:筛选部门时藏起来 —— 那会儿用户是在树里找别的部门。 */}
        {recent.length > 0 && !deptFilter.trim() && (
          <>
            <h3 className={sectionCls}>{t('page.recent')}</h3>
            {recent.map((dept) => (
              <SidebarEntry
                key={dept.id}
                icon={<RiHistoryLine size={16} />}
                label={dept.name}
                count={dept.member_count}
                // 刻意不给选中态:同一个部门会同时在树下高亮,两处都亮反而说不清
                // 在哪。这里是快捷方式,不是第二个选中项。
                active={false}
                onClick={() => onSelectDept(dept.id)}
                testId={`contacts-recent-${dept.id}`}
              />
            ))}
          </>
        )}

        <h3 className={sectionCls}>{t('page.sectionOrg')}</h3>
        <SidebarEntry
          icon={<RiTeamLine size={16} />}
          label={t('page.orgMembers')}
          count={counts.members}
          active={view === null && selectedDeptId === null}
          onClick={onSelectAll}
          testId="contacts-all-entry"
        />
        <DepartmentTree
          departments={departments}
          selectedId={selectedDeptId}
          onSelect={onSelectDept}
          filter={deptFilter}
        />
      </nav>
    </aside>
  )
}

interface EntryProps {
  icon: ReactNode
  /** 选中时换一个图标(目前只有星标是实心/空心两态)。 */
  activeIcon?: ReactNode
  label: string
  count?: number | null
  /** 红标(未读 / 待处理),与 count 是两个位置:红标在数字左边、更醒目。 */
  badge?: number
  badgeLabel?: string
  badgeTestId?: string
  active: boolean
  onClick: () => void
  testId: string
}

const SidebarEntry = ({
  icon,
  activeIcon,
  label,
  count,
  badge,
  badgeLabel,
  badgeTestId,
  active,
  onClick,
  testId,
}: EntryProps) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testId}
    aria-current={active ? 'true' : undefined}
    className={cx(entryCls, activeCls(active))}
  >
    <span className={iconCls} aria-hidden>
      {active && activeIcon ? activeIcon : icon}
    </span>
    <span className={entryLabelCls}>{label}</span>
    {typeof badge === 'number' && badge > 0 && (
      <span
        className={badgeCls}
        aria-label={badgeLabel}
        data-testid={badgeTestId}
      >
        {badge > 99 ? '99+' : badge}
      </span>
    )}
    {typeof count === 'number' && (
      <span className={countCls}>{count > 999 ? '999+' : count}</span>
    )}
  </button>
)

const asideCls = css({
  width: '100%',
  height: '100%',
  borderRight: '1px solid token(colors.greyscale.200)',
  overflowY: 'auto',
  backgroundColor: 'greyscale.50',
})

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
})
const collapseBtnCls = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.75rem',
  height: '1.75rem',
  border: 'none',
  borderRadius: '6px',
  background: 'transparent',
  color: 'greyscale.500',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100', color: 'greyscale.800' },
})

const filterWrapCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  marginX: '0.75rem',
  marginBottom: '0.5rem',
  paddingX: '0.5rem',
  paddingY: '0.3125rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  // 里层 input 没有自己的边框/描边(outline: none),聚焦提示必须落在这一圈上,
  // 否则键盘用户完全看不出焦点在哪。
  _focusWithin: { borderColor: 'border.focus' },
})
const filterIconCls = css({ flexShrink: 0, color: 'greyscale.500' })
const filterInputCls = css({
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'default.text',
  fontSize: '0.8125rem',
  padding: 0,
})

const sectionCls = css({
  margin: 0,
  paddingX: '1rem',
  paddingTop: '0.625rem',
  paddingBottom: '0.25rem',
  fontSize: '0.6875rem',
  fontWeight: '600',
  letterSpacing: '0.02em',
  color: 'greyscale.500',
})

const entryCls = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  width: '100%',
  border: 'none',
  borderBottom: '1px solid token(colors.greyscale.100)',
  textAlign: 'left',
  paddingX: '1rem',
  paddingY: '0.5rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  // 选中标记:左侧实色条。底色差异在深色下天然微弱,实色条不会(见 panda.config
  // 里 selected.accent 的注释)。
  '&::before': {
    content: '""',
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '2px',
  },
})
const activeCls = (active: boolean) =>
  css({
    color: active ? 'selected.text' : 'greyscale.800',
    fontWeight: active ? '600' : undefined,
    backgroundColor: active ? 'selected.bg' : 'transparent',
    // hover 也要分选中/未选中:无条件盖灰底会把选中行的蓝字压在中性灰上。
    _hover: { backgroundColor: active ? 'selected.bg' : 'greyscale.100' },
    '&::before': {
      backgroundColor: active ? 'selected.accent' : 'transparent',
    },
  })
const iconCls = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  color: 'inherit',
})
const entryLabelCls = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const countCls = css({
  flexShrink: 0,
  fontSize: '0.6875rem',
  fontVariantNumeric: 'tabular-nums',
  color: 'greyscale.500',
})
const badgeCls = css({
  flexShrink: 0,
  minWidth: '1.125rem',
  paddingX: '0.3125rem',
  paddingY: '0.0625rem',
  borderRadius: '999px',
  fontSize: '0.6875rem',
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'center',
  backgroundColor: 'danger.subtle',
  color: 'danger.subtle-text',
})
