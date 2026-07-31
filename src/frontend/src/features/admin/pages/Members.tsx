import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { keepPreviousData } from '@tanstack/react-query'
import {
  Menu as RACMenu,
  MenuItem,
  Button as RACButton,
} from 'react-aria-components'
import { RiMoreFill, RiSearchLine, RiUserAddLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'
import { Menu } from '@/primitives/Menu'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'

import {
  type AdminMember,
  MEMBER_STATUSES,
  ORG_ROLES,
  deleteMembership,
  fetchAdminMembers,
  updateMembership,
} from '../api/adminMembers'
import { fetchAdminDepartments } from '../api/adminDepartments'
import { createInvitation, fetchInvitations } from '../api/adminInvitations'
import { describeApiError } from '../api/errors'
import { SelectDialog } from '../components/SelectDialog'
import { TextPromptDialog } from '../components/TextPromptDialog'
import { InviteDialog } from '../components/InviteDialog'
import { InvitationsPanel } from '../components/InvitationsPanel'

const MEMBERS_KEY = ['admin', 'members']

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
  const [view, setView] = useState<'members' | 'invitations'>('members')
  const [inviteOpen, setInviteOpen] = useState(false)

  const filters = { status, department, q, page }

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
            <button type="submit" aria-label={t('members.search')} className={iconBtn}>
              <RiSearchLine size={16} />
            </button>
          </form>
        </div>
        )}
      </div>

      <div className={css({ flex: 1, overflowY: 'auto' })}>
        {view === 'invitations' ? (
          <InvitationsPanel />
        ) : isFetching && members.length === 0 ? (
          <p className={emptyText}>{t('members.loading')}</p>
        ) : members.length === 0 ? (
          <p className={emptyText}>{t('members.noMembers')}</p>
        ) : (
          <table className={css({ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' })}>
            <thead>
              <tr className={css({ textAlign: 'left', color: 'greyscale.500', borderBottom: '1px solid token(colors.greyscale.200)' })}>
                <th className={th}>{t('members.colMember')}</th>
                <th className={th}>{t('members.colDepartment')}</th>
                <th className={th}>{t('members.colRole')}</th>
                <th className={th}>{t('members.colStatus')}</th>
                <th className={css({ ...thBase, width: '3rem' })} />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.id}
                  className={css({
                    borderBottom: '1px solid token(colors.greyscale.100)',
                    _hover: { backgroundColor: 'greyscale.50' },
                  })}
                >
                  <td className={td}>
                    <div className={css({ display: 'flex', alignItems: 'center', gap: '0.625rem' })}>
                      {m.avatar_url ? (
                        <img
                          src={m.avatar_url}
                          alt=""
                          className={css({ width: '32px', height: '32px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 })}
                        />
                      ) : (
                        <span className={css({ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'primary.500', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 })}>
                          {(displayName(m) || '?').slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className={css({ minWidth: 0 })}>
                        <span className={css({ display: 'block', fontWeight: 'medium', color: 'greyscale.900' })}>
                          {displayName(m)}
                          {m.title && (
                            <span className={css({ color: 'greyscale.400', fontWeight: 'normal' })}> · {m.title}</span>
                          )}
                        </span>
                        <span className={css({ display: 'block', fontSize: '0.75rem', color: 'greyscale.500' })}>
                          {m.email}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className={td}>{m.department?.name ?? t('members.orgLevel')}</td>
                  <td className={td}>{roleLabel(m.org_role)}</td>
                  <td className={td}>
                    <StatusBadge status={m.status} label={statusLabel(m.status)} />
                  </td>
                  <td className={td}>
                    <Menu>
                      <RACButton aria-label={t('members.rowActions')} className={iconBtn}>
                        <RiMoreFill size={18} />
                      </RACButton>
                      <RACMenu className={menuList}>
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
                        <MenuItem className={menuItemDanger} onAction={() => remove(m)}>
                          {t('members.remove')}
                        </MenuItem>
                      </RACMenu>
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {view === 'members' && (
      <div
        className={css({
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '0.75rem',
          paddingX: '1.25rem',
          paddingY: '0.625rem',
          borderTop: '1px solid token(colors.greyscale.200)',
          fontSize: '0.8125rem',
          color: 'greyscale.600',
        })}
      >
        <span>{t('members.total', { count: data?.count ?? 0 })}</span>
        <Button
          variant="secondary"
          size="dense"
          isDisabled={!data?.previous}
          onPress={() => setPage((p) => Math.max(1, p - 1))}
        >
          {t('members.prev')}
        </Button>
        <Button
          variant="secondary"
          size="dense"
          isDisabled={!data?.next}
          onPress={() => setPage((p) => p + 1)}
        >
          {t('members.next')}
        </Button>
      </div>
      )}

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
  invited: css({ backgroundColor: 'primary.100', color: 'primary.700' }),
  suspended: css({ backgroundColor: 'error.200', color: 'error.900' }),
  left: css({ backgroundColor: 'greyscale.200', color: 'greyscale.700' }),
}

const StatusBadge = ({ status, label }: { status: string; label: string }) => (
  <span className={`${badgeBase} ${badgeByStatus[status] ?? badgeByStatus.left}`}>
    {label}
  </span>
)

const thBase = {
  paddingX: '1rem',
  paddingY: '0.625rem',
  fontWeight: '600' as const,
}
const th = css(thBase)
const td = css({ paddingX: '1rem', paddingY: '0.5rem', color: 'greyscale.800', verticalAlign: 'middle' })
const emptyText = css({ padding: '1.5rem', color: 'greyscale.500', fontSize: '0.9375rem' })
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
  backgroundColor: 'primary.100',
  color: 'primary.700',
  fontSize: '0.6875rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
})
const iconBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.75rem',
  height: '1.75rem',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.600',
  borderRadius: '4px',
  _hover: { backgroundColor: 'greyscale.200' },
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
  color: 'error.700',
  _hover: { backgroundColor: 'error.50' },
})
