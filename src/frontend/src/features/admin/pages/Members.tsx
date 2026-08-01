import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { keepPreviousData } from '@tanstack/react-query'
import { Menu as RACMenu, MenuItem } from 'react-aria-components'
import { RiMoreFill, RiSearchLine, RiUserAddLine } from '@remixicon/react'
import Table, { type ColumnProps } from '@douyinfe/semi-ui/lib/es/table'

import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'
import { Menu } from '@/primitives/Menu'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'

import {
  type AdminMember,
  type OffboardInput,
  BULK_LIMIT,
  MEMBER_STATUSES,
  ORG_ROLES,
  bulkChangeDepartment,
  bulkOffboard,
  deleteMembership,
  fetchAdminMembers,
  offboardMember,
  updateMembership,
} from '../api/adminMembers'
import { fetchDictItems } from '../api/adminDictionaries'
import { fetchAdminDepartments } from '../api/adminDepartments'
import { createInvitation, fetchInvitations } from '../api/adminInvitations'
import { describeApiError } from '../api/errors'
import { SelectDialog } from '../components/SelectDialog'
import { TextPromptDialog } from '../components/TextPromptDialog'
import { InviteDialog } from '../components/InviteDialog'
import { InvitationsPanel } from '../components/InvitationsPanel'
import { DepartedPanel } from '../components/DepartedPanel'
import { MemberEditPanel } from '../components/MemberEditPanel'
import { OffboardDialog } from '../components/OffboardDialog'

const MEMBERS_KEY = ['admin', 'members']
/** 与后端 REST_FRAMEWORK.PAGE_SIZE 一致(settings.py)。Semi 分页要显式给。 */
const MEMBERS_PAGE_SIZE = 20

export const AdminMembers = () => {
  const { t } = useTranslation('admin')
  const { confirm, alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()

  const [status, setStatus] = useState('')
  const [department, setDepartment] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)

  const [roleTarget, setRoleTarget] = useState<AdminMember | null>(null)
  const [deptTarget, setDeptTarget] = useState<AdminMember | null>(null)
  const [titleTarget, setTitleTarget] = useState<AdminMember | null>(null)
  const [view, setView] = useState<'members' | 'departed' | 'invitations'>(
    'members'
  )
  const [inviteOpen, setInviteOpen] = useState(false)
  const [employeeType, setEmployeeType] = useState('')
  const [editTarget, setEditTarget] = useState<AdminMember | null>(null)
  const [offboardTarget, setOffboardTarget] = useState<AdminMember | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [bulkDeptOpen, setBulkDeptOpen] = useState(false)

  // 已离职是独立 tab,所以成员 tab 永远排掉 left —— 否则同一个人会在两个 tab
  // 里各出现一次,而两处的操作集完全不同。
  const filters = {
    status: status || undefined,
    exclude_status: status ? undefined : 'left',
    department,
    employee_type: employeeType,
    q,
    page,
  }

  const { data, isFetching } = useQuery({
    queryKey: [...MEMBERS_KEY, filters],
    queryFn: () => fetchAdminMembers(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })

  const { data: departments = [] } = useQuery({
    queryKey: ['admin', 'departments'],
    queryFn: fetchAdminDepartments,
    staleTime: 30_000,
  })

  const { data: employeeTypes = [] } = useQuery({
    queryKey: ['admin', 'dict', 'employee_type'],
    queryFn: () => fetchDictItems('employee_type'),
    staleTime: 5 * 60_000,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: MEMBERS_KEY })
  const onError = (e: unknown) => showAlert({ message: describeApiError(e) })

  const updateMut = useMutation({
    mutationFn: (vars: { id: string; input: Record<string, unknown> }) =>
      updateMembership(vars.id, vars.input),
    onSuccess: () => {
      invalidate()
      setRoleTarget(null)
      setDeptTarget(null)
      setTitleTarget(null)
    },
    onError,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMembership(id),
    onSuccess: invalidate,
    onError,
  })

  const offboardMut = useMutation({
    mutationFn: (vars: { id: string; input: OffboardInput }) =>
      offboardMember(vars.id, vars.input),
    onSuccess: () => {
      invalidate()
      setOffboardTarget(null)
    },
    onError,
  })

  /** Report what the batch could not do rather than claiming a clean sweep. */
  const reportSkipped = (done: number, skipped: { label: string }[]) => {
    invalidate()
    setSelected([])
    if (skipped.length) {
      void showAlert({
        message: t('members.bulkPartial', {
          done,
          skipped: skipped.length,
          names: skipped.map((s) => s.label).join('、'),
        }),
      })
    }
  }

  const bulkDeptMut = useMutation({
    mutationFn: (vars: { ids: string[]; department: string | null }) =>
      bulkChangeDepartment(vars.ids, vars.department),
    onSuccess: (r) => reportSkipped(r.moved, r.skipped),
    onError,
  })

  const bulkOffboardMut = useMutation({
    mutationFn: (ids: string[]) => bulkOffboard(ids),
    onSuccess: (r) => reportSkipped(r.offboarded, r.skipped),
    onError,
  })

  // Pending-invitation count for the tab badge (shared cache with the panel).
  const { data: inviteData } = useQuery({
    queryKey: ['admin', 'invitations'],
    queryFn: () => fetchInvitations('pending'),
    staleTime: 15_000,
  })
  const pendingCount = inviteData?.count ?? 0

  const inviteMut = useMutation({
    mutationFn: createInvitation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] })
      invalidate()
      setInviteOpen(false)
    },
    onError,
  })

  const members = data?.results ?? []
  const roleLabel = (r: string) => t(`role.${r}`, { defaultValue: r })
  const statusLabel = (s: string) => t(`status.${s}`, { defaultValue: s })
  const displayName = (m: AdminMember) =>
    m.full_name || m.short_name || m.email || m.sub || ''

  const applySearch = () => {
    setQ(searchInput.trim())
    setPage(1)
  }

  const toggleSuspend = async (m: AdminMember) => {
    const suspend = m.status === 'active'
    const ok = await confirm({
      message: t(suspend ? 'members.suspendConfirm' : 'members.restoreConfirm', {
        name: displayName(m),
      }),
      danger: suspend,
    })
    if (!ok) return
    updateMut.mutate({
      id: m.id,
      input: { status: suspend ? 'suspended' : 'active' },
    })
  }

  const remove = async (m: AdminMember) => {
    const ok = await confirm({
      message: t('members.removeConfirm', { name: displayName(m) }),
      danger: true,
    })
    if (!ok) return
    deleteMut.mutate(m.id)
  }

  // 列定义。单元格内部仍用我们自己的 primitives(Button/Menu)与 panda token ——
  // 试点只换「表格骨架 + 分页」这层,行内控件不动,免得一次改两套东西说不清
  // 是谁的问题。
  const columns: ColumnProps<AdminMember>[] = [
    {
      title: t('members.colMember'),
      dataIndex: 'id',
      width: 320,
      render: (_: unknown, m: AdminMember) => (
        <div className={memberCellCls}>
          {m.avatar_url ? (
            <img src={m.avatar_url} alt="" className={avatarCls} />
          ) : (
            <span className={avatarFallbackCls}>
              {(displayName(m) || '?').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className={css({ minWidth: 0 })}>
            <span className={memberNameCls}>
              {displayName(m)}
              {m.title && <span className={memberTitleCls}> · {m.title}</span>}
            </span>
            <span className={memberEmailCls}>{m.email}</span>
          </span>
        </div>
      ),
    },
    // ⚠️ 五列**都要**给宽度。只给部分列设宽度会更糟:Semi Table 一旦有列带
    // width 就切到 table-layout: fixed,富余宽度全部灌给没设宽度的那一列 ——
    // 实测「成员」列因此从 877px 涨到 1080px,比不设宽度还宽。
    // 全部设上之后富余按各自宽度比例摊,五列才不会一头沉。
    {
      title: t('members.colDepartment'),
      width: 150,
      render: (_: unknown, m: AdminMember) =>
        m.department?.name ?? t('members.orgLevel'),
    },
    {
      title: t('members.colRole'),
      width: 150,
      render: (_: unknown, m: AdminMember) => roleLabel(m.org_role),
    },
    {
      title: t('members.colStatus'),
      width: 120,
      render: (_: unknown, m: AdminMember) => (
        <StatusBadge status={m.status} label={statusLabel(m.status)} />
      ),
    },
    {
      title: '',
      width: 60,
      render: (_: unknown, m: AdminMember) => (
        <Menu>
          <Button
            variant="quaternaryText"
            size="icon28"
            aria-label={t('members.rowActions')}
          >
            <RiMoreFill size={18} />
          </Button>
          <RACMenu className={menuList}>
            <MenuItem className={menuItem} onAction={() => setEditTarget(m)}>
              {t('members.edit')}
            </MenuItem>
            <MenuItem className={menuItem} onAction={() => setRoleTarget(m)}>
              {t('members.changeRole')}
            </MenuItem>
            <MenuItem className={menuItem} onAction={() => setDeptTarget(m)}>
              {t('members.changeDepartment')}
            </MenuItem>
            <MenuItem className={menuItem} onAction={() => setTitleTarget(m)}>
              {t('members.changeTitle')}
            </MenuItem>
            <MenuItem className={menuItem} onAction={() => toggleSuspend(m)}>
              {m.status === 'active' ? t('members.suspend') : t('members.restore')}
            </MenuItem>
            <MenuItem
              className={menuItemDanger}
              onAction={() => setOffboardTarget(m)}
            >
              {t('members.offboard')}
            </MenuItem>
            <MenuItem className={menuItemDanger} onAction={() => remove(m)}>
              {t('members.remove')}
            </MenuItem>
          </RACMenu>
        </Menu>
      ),
    },
  ]

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', height: '100%' })}>
      <div
        className={css({
          flexShrink: 0,
          paddingX: '1.25rem',
          paddingY: '0.875rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' })}>
          <h1 className={css({ fontSize: '1.125rem', fontWeight: 'bold', color: 'greyscale.900' })}>
            {t('members.title')}
          </h1>
          <Button
            size="sm"
            variant="primary"
            icon={<RiUserAddLine size={16} />}
            onPress={() => setInviteOpen(true)}
          >
            {t('invite.button')}
          </Button>
        </div>
        <div className={css({ display: 'flex', gap: '1rem', marginBottom: '0.75rem', borderBottom: '1px solid token(colors.greyscale.200)' })}>
          <button type="button" onClick={() => setView('members')} className={tab(view === 'members')}>
            {t('members.tabMembers')}
          </button>
          <button type="button" onClick={() => setView('departed')} className={tab(view === 'departed')}>
            {t('members.tabDeparted')}
          </button>
          <button type="button" onClick={() => setView('invitations')} className={tab(view === 'invitations')}>
            {t('members.tabInvitations')}
            {pendingCount > 0 && <span className={tabBadge}>{pendingCount}</span>}
          </button>
        </div>
        {view === 'members' && (
        <div className={css({ display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'center' })}>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
            className={filterSelect}
          >
            <option value="">{t('members.filterAllStatus')}</option>
            {MEMBER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value)
              setPage(1)
            }}
            className={filterSelect}
          >
            <option value="">{t('members.filterAllDepartments')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            value={employeeType}
            onChange={(e) => {
              setEmployeeType(e.target.value)
              setPage(1)
            }}
            className={filterSelect}
          >
            <option value="">{t('members.filterAllEmployeeTypes')}</option>
            {employeeTypes.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              applySearch()
            }}
            className={css({ display: 'flex', alignItems: 'center', gap: '0.375rem' })}
          >
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('members.searchPlaceholder')}
              className={css({
                width: '14rem',
                padding: '0.375rem 0.5rem',
                border: '1px solid token(colors.control.border)',
                borderRadius: '4px',
                backgroundColor: 'greyscale.000',
                color: 'default.text',
                fontSize: '0.875rem',
              })}
            />
            <Button
              type="submit"
              variant="quaternaryText"
              size="icon28"
              aria-label={t('members.search')}
            >
              <RiSearchLine size={16} />
            </Button>
          </form>
        </div>
        )}
      </div>

      {view === 'members' && selected.length > 0 && (
        <div className={bulkBarCls}>
          <span className={css({ fontSize: '0.875rem', color: 'greyscale.700' })}>
            {t('members.bulkSelected', { count: selected.length })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={bulkDeptMut.isPending}
            onPress={() => setBulkDeptOpen(true)}
          >
            {t('members.bulkChangeDepartment')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            isDisabled={bulkOffboardMut.isPending}
            onPress={async () => {
              const ok = await confirm({
                message: t('members.bulkOffboardConfirm', {
                  count: selected.length,
                }),
                danger: true,
              })
              if (ok) bulkOffboardMut.mutate(selected)
            }}
          >
            {t('members.bulkOffboard')}
          </Button>
          <Button size="sm" variant="tertiaryText" onPress={() => setSelected([])}>
            {t('members.bulkClear')}
          </Button>
        </div>
      )}

      <div className={css({ flex: 1, overflowY: 'auto' })}>
        {view === 'invitations' ? (
          <InvitationsPanel />
        ) : view === 'departed' ? (
          <DepartedPanel />
        ) : (
          /* Semi Table 试点(见 vite.config.ts 顶部说明):替掉原来的手搓
             <table> + 手写 prev/next 页脚。分页、加载态、空态都由组件自带,
             调用点只剩「列定义 + 数据」。 */
          <Table<AdminMember>
            columns={columns}
            dataSource={members}
            rowKey="id"
            loading={isFetching && members.length === 0}
            size="middle"
            empty={t('members.noMembers')}
            rowSelection={{
              selectedRowKeys: selected,
              // 上限与服务端一致,免得攒够 201 个再吃一个 400。
              onChange: (keys) =>
                setSelected((keys ?? []).slice(0, BULK_LIMIT) as string[]),
            }}
            pagination={{
              currentPage: page,
              pageSize: MEMBERS_PAGE_SIZE,
              total: data?.count ?? 0,
              onPageChange: setPage,
              // showTotal 会在右侧再渲染一个「总页数: N」,和左边的「共 N 人」
              // 重复且信息量更低,关掉。总数只保留左侧这一处,沿用既有 i18n key。
              showTotal: false,
              formatPageText: () => t('members.total', { count: data?.count ?? 0 }),
            }}
          />
        )}
      </div>

      <InviteDialog
        isOpen={inviteOpen}
        departments={departments}
        submitting={inviteMut.isPending}
        onSubmit={(input) => inviteMut.mutate(input)}
        onClose={() => setInviteOpen(false)}
      />

      <SelectDialog
        isOpen={roleTarget !== null}
        title={t('members.changeRoleTitle')}
        options={ORG_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
        initialValue={roleTarget?.org_role ?? 'member'}
        confirmLabel={t('actions.save')}
        submitting={updateMut.isPending}
        onSubmit={(value) =>
          roleTarget && updateMut.mutate({ id: roleTarget.id, input: { org_role: value } })
        }
        onClose={() => setRoleTarget(null)}
      />

      <SelectDialog
        isOpen={deptTarget !== null}
        title={t('members.changeDepartmentTitle')}
        options={[
          { value: '', label: t('members.orgLevel') },
          ...departments.map((d) => ({ value: d.id, label: d.name })),
        ]}
        initialValue={deptTarget?.department?.id ?? ''}
        confirmLabel={t('actions.save')}
        submitting={updateMut.isPending}
        onSubmit={(value) =>
          deptTarget &&
          updateMut.mutate({ id: deptTarget.id, input: { department: value || null } })
        }
        onClose={() => setDeptTarget(null)}
      />

      <MemberEditPanel
        member={editTarget}
        departments={departments}
        onClose={() => setEditTarget(null)}
      />

      <OffboardDialog
        member={offboardTarget}
        submitting={offboardMut.isPending}
        onSubmit={(input) =>
          offboardTarget &&
          offboardMut.mutate({ id: offboardTarget.id, input })
        }
        onClose={() => setOffboardTarget(null)}
      />

      <SelectDialog
        isOpen={bulkDeptOpen}
        title={t('members.bulkChangeDepartmentTitle')}
        options={[
          { value: '', label: t('members.orgLevel') },
          ...departments.map((d) => ({ value: d.id, label: d.name })),
        ]}
        initialValue=""
        confirmLabel={t('actions.save')}
        submitting={bulkDeptMut.isPending}
        onSubmit={(value) => {
          bulkDeptMut.mutate({ ids: selected, department: value || null })
          setBulkDeptOpen(false)
        }}
        onClose={() => setBulkDeptOpen(false)}
      />

      <TextPromptDialog
        isOpen={titleTarget !== null}
        title={t('members.changeTitleTitle')}
        label={t('members.titlePlaceholder')}
        initialValue={titleTarget?.title ?? ''}
        confirmLabel={t('actions.save')}
        submitting={updateMut.isPending}
        onSubmit={(value) =>
          titleTarget && updateMut.mutate({ id: titleTarget.id, input: { title: value } })
        }
        onClose={() => setTitleTarget(null)}
      />
    </div>
  )
}

// Static per-status classes — Panda resolves tokens at build time, so the
// colours can't be computed from a runtime object; we pick a prebuilt class.
const badgeBase = css({
  display: 'inline-block',
  paddingX: '0.5rem',
  paddingY: '0.125rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
})
const badgeByStatus: Record<string, string> = {
  active: css({ backgroundColor: 'success.subtle', color: 'success.subtle-text' }),
  invited: css({ backgroundColor: 'brand.100', color: 'brand.700' }),
  suspended: css({ backgroundColor: 'error.200', color: 'error.900' }),
  left: css({ backgroundColor: 'greyscale.200', color: 'greyscale.700' }),
}

const StatusBadge = ({ status, label }: { status: string; label: string }) => (
  <span className={`${badgeBase} ${badgeByStatus[status] ?? badgeByStatus.left}`}>
    {label}
  </span>
)

/* 表头/单元格/空态的样式已由 Semi Table 接管,原先的 thBase/th/td/emptyText
   随手搓 <table> 一起删除。下面这几个是「成员」列内部的排版,仍归我们自己。 */
const memberCellCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
})
const avatarCls = css({
  width: '32px',
  height: '32px',
  borderRadius: '8px',
  objectFit: 'cover',
  flexShrink: 0,
})
const avatarFallbackCls = css({
  width: '32px',
  height: '32px',
  borderRadius: '8px',
  backgroundColor: 'primary.500',
  color: 'white',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
})
const memberNameCls = css({
  display: 'block',
  fontWeight: 'medium',
  color: 'greyscale.900',
})
const memberTitleCls = css({ color: 'greyscale.400', fontWeight: 'normal' })
const memberEmailCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const filterSelect = cx(
  css({
    padding: '0.375rem 0.5rem',
    border: '1px solid token(colors.control.border)',
    borderRadius: '4px',
    backgroundColor: 'greyscale.000',
    color: 'default.text',
    fontSize: '0.875rem',
  }),
  selectChrome
)
const tab = (active: boolean) =>
  css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    paddingX: '0.25rem',
    paddingBottom: '0.5rem',
    marginBottom: '-1px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: active ? 'primary.700' : 'greyscale.600',
    fontWeight: active ? '600' : undefined,
    borderBottom: active
      ? '2px solid token(colors.primary.600)'
      : '2px solid transparent',
  })
const tabBadge = css({
  minWidth: '1.125rem',
  height: '1.125rem',
  paddingX: '0.25rem',
  borderRadius: '999px',
  backgroundColor: 'brand.100',
  color: 'brand.700',
  fontSize: '0.6875rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
})
const bulkBarCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '1.25rem',
  paddingY: '0.625rem',
  backgroundColor: 'brand.100',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const menuList = css({ outline: 'none', minWidth: '9rem' })
const menuItem = css({
  padding: '0.5rem 0.75rem',
  cursor: 'pointer',
  outline: 'none',
  fontSize: '0.875rem',
  color: 'greyscale.800',
  _hover: { backgroundColor: 'greyscale.100' },
})
const menuItemDanger = css({
  padding: '0.5rem 0.75rem',
  cursor: 'pointer',
  outline: 'none',
  fontSize: '0.875rem',
  // 两个坑一起修:① error.50 这个 token 不存在(error 色阶是 100–950),
  // 产出的是非法字面量、hover 底色整条被丢弃;② error 是**反向色阶**
  // (100 最暗、950 最亮),error.700=#F28D8A 是浅粉,压在白菜单上只有 2.35:1。
  // 换成会翻转的 danger.subtle 配对:浅色 6.5:1、深色 12.7:1。
  color: 'danger.subtle-text',
  _hover: { backgroundColor: 'danger.subtle' },
})
