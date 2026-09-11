import { useTranslation } from 'react-i18next'
import { RiChatNewLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'

import type { DirectoryDepartment } from '../api/ApiDirectory'
import { MemberAvatar } from './MemberAvatar'

interface Props {
  department: DirectoryDepartment
  /** Ancestors from the root down, excluding the department itself. */
  ancestors: DirectoryDepartment[]
  /** Opens the head's member card in the same right-hand column. */
  onOpenHead?: (userId: string) => void
  /**
   * 用这个部门的人建一个群。只在有直属成员时给 —— 空部门没什么可拉的。
   * 真正的建群动作在路由里(它还要弹确认框、跳会话)。
   */
  onStartGroupChat?: () => void
  startingGroupChat?: boolean
}

/**
 * Right-hand panel when a department is selected but no person is.
 *
 * The one thing this finally puts on screen is the department head: the field
 * has been on `DirectoryDepartment` since P1 and rendered nowhere, so "who runs
 * this team" was a question the directory could answer but never did.
 */
export const DepartmentDetailPanel = ({
  department,
  ancestors,
  onOpenHead,
  onStartGroupChat,
  startingGroupChat,
}: Props) => {
  const { t } = useTranslation('contacts')
  const head = department.head

  return (
    <aside className={panelCls} data-testid="contacts-department-detail">
      <div className={headerCls}>
        <div className={iconCls} aria-hidden>
          {department.name.slice(0, 1)}
        </div>
        <h2 className={nameCls}>{department.name}</h2>
        {ancestors.length > 0 && (
          <div className={pathCls}>
            {ancestors.map((a) => a.name).join(' / ')}
          </div>
        )}
      </div>

      <dl className={listCls}>
        <div className={rowCls}>
          <dt className={dtCls}>{t('department.memberCount')}</dt>
          <dd className={ddCls}>
            {t('department.people', { count: department.member_count ?? 0 })}
          </dd>
        </div>
        <div className={rowCls}>
          <dt className={dtCls}>{t('department.head')}</dt>
          <dd className={ddCls}>
            {head ? (
              <button
                type="button"
                className={headBtnCls}
                onClick={() => onOpenHead?.(head.id)}
              >
                <MemberAvatar
                  src={null}
                  name={head.full_name || head.short_name || ''}
                  size="20px"
                />
                <span>{head.full_name || head.short_name}</span>
              </button>
            ) : (
              <span className={mutedCls}>{t('department.noHead')}</span>
            )}
          </dd>
        </div>
        {department.code && (
          <div className={rowCls}>
            <dt className={dtCls}>{t('department.code')}</dt>
            <dd className={ddCls}>{department.code}</dd>
          </div>
        )}
      </dl>

      {/* 部门级动作:把这一整个部门拉进一个群。部门是组织里现成的「一伙人」,
          比在选人器里一个个点快得多 —— 但要先问一句,建群会通知到每个人。 */}
      {onStartGroupChat && (
        <div className={actionsCls}>
          <Button
            variant="secondary"
            onPress={onStartGroupChat}
            loading={startingGroupChat}
            data-testid="contacts-dept-group-chat"
            className={css({ width: '100%' })}
          >
            <RiChatNewLine size={16} aria-hidden />
            {t('department.startGroupChat')}
          </Button>
        </div>
      )}
    </aside>
  )
}

const actionsCls = css({
  marginTop: '1.25rem',
  paddingTop: '1rem',
  borderTop: '1px solid token(colors.greyscale.100)',
})

const panelCls = css({
  width: '300px',
  flexShrink: 0,
  borderLeft: '1px solid token(colors.greyscale.200)',
  padding: '1.25rem',
  overflowY: 'auto',
})
const headerCls = css({ textAlign: 'center', marginBottom: '1.25rem' })
const iconCls = css({
  width: '56px',
  height: '56px',
  margin: '0 auto 0.75rem',
  borderRadius: '14px',
  backgroundColor: 'brand.100',
  color: 'brand.700',
  fontSize: '1.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
})
const nameCls = css({
  margin: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const pathCls = css({
  marginTop: '0.25rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const listCls = css({ margin: 0 })
const rowCls = css({
  display: 'flex',
  gap: '0.75rem',
  paddingY: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const dtCls = css({
  width: '5rem',
  flexShrink: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})
const ddCls = css({
  margin: 0,
  minWidth: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.900',
})
const headBtnCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  color: 'primary.500',
  fontSize: '0.8125rem',
})
const mutedCls = css({ color: 'greyscale.400' })
