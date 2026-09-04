import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { PageState } from '@/components/PageState'
import { ResizablePanel } from '@/components/ResizablePanel'
import { StateHint } from '@/components/StateHint'
import { useHasPermission } from '@/hooks/useOrgContext'

import {
  type AdminRole,
  deleteAdminRole,
  deleteRoleAssignment,
  fetchAdminRoles,
  fetchPermissionCatalogue,
  fetchRoleAssignments,
  updateAdminRole,
} from '../api/adminRoles'
import { describeRoleError } from '../api/errors'
import { RoleCreateDialog } from '../components/RoleCreateDialog'
import { RoleAssignDialog } from '../components/RoleAssignDialog'

const ROLES_KEY = ['admin', 'roles']
const ASSIGNMENTS_KEY = ['admin', 'role-assignments']

/**
 * 「角色与权限」。
 *
 * 两件事在这一页刻意做得显眼:
 * 1. **只读态是一等的** —— 持有 `org.role.read` 但没有 `org.role.write` 的人
 *    (比如 IT 角色)看得到谁有什么权限,但改不了。审计要看得见,才有意义。
 * 2. `org.role.write` 在服务端就**不允许被放进任何自定义角色**,所以这里连
 *    勾选框都不渲染它 —— 让人勾一个必定被 400 拒掉的框是纯粹的坑。
 */
export const AdminRoles = () => {
  const { t } = useTranslation('admin')
  const { confirm, alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()
  const has = useHasPermission()
  const canWrite = has('org.role.write')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [assigningTo, setAssigningTo] = useState<AdminRole | null>(null)

  const {
    data: roles = [],
    isFetching: rolesFetching,
    isError: rolesError,
    refetch: refetchRoles,
  } = useQuery({
    queryKey: ROLES_KEY,
    queryFn: fetchAdminRoles,
    staleTime: 30_000,
  })
  const {
    data: catalogue = [],
    isFetching: catalogueFetching,
    isError: catalogueError,
    refetch: refetchCatalogue,
  } = useQuery({
    queryKey: ['admin', 'permission-catalogue'],
    queryFn: fetchPermissionCatalogue,
    staleTime: 10 * 60_000,
  })
  const {
    data: assignments = [],
    isFetching: assignmentsFetching,
    isError: assignmentsError,
    refetch: refetchAssignments,
  } = useQuery({
    queryKey: [...ASSIGNMENTS_KEY, selectedId],
    queryFn: () => fetchRoleAssignments({ role: selectedId as string }),
    enabled: selectedId !== null,
    staleTime: 30_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ROLES_KEY })
    queryClient.invalidateQueries({ queryKey: ASSIGNMENTS_KEY })
  }
  const onError = (e: unknown) =>
    showAlert({ message: describeRoleError(t, e) })

  const permissionMut = useMutation({
    mutationFn: (vars: { id: string; permissions: string[] }) =>
      updateAdminRole(vars.id, { permissions: vars.permissions }),
    onSuccess: invalidate,
    onError,
  })

  const deleteRoleMut = useMutation({
    mutationFn: (id: string) => deleteAdminRole(id),
    onSuccess: (_d, id) => {
      invalidate()
      if (selectedId === id) setSelectedId(null)
    },
    onError,
  })

  const unassignMut = useMutation({
    mutationFn: (id: string) => deleteRoleAssignment(id),
    onSuccess: invalidate,
    onError,
  })

  const selected = roles.find((r) => r.id === selectedId) ?? null

  // owner_only 的权限点不渲染:服务端拒绝把它放进任何自定义角色,勾了必被 400。
  const grantable = useMemo(
    () => catalogue.filter((p) => !p.owner_only),
    [catalogue]
  )
  const byGroup = useMemo(() => {
    const map = new Map<string, typeof grantable>()
    for (const entry of grantable) {
      const bucket = map.get(entry.group) ?? []
      bucket.push(entry)
      map.set(entry.group, bucket)
    }
    return [...map.entries()]
  }, [grantable])

  const togglePermission = (role: AdminRole, code: string) => {
    const next = role.permissions.includes(code)
      ? role.permissions.filter((p) => p !== code)
      : [...role.permissions, code]
    permissionMut.mutate({ id: role.id, permissions: next })
  }

  const removeRole = async (role: AdminRole) => {
    const ok = await confirm({
      message: t('roles.deleteConfirm', {
        name: role.name,
        count: role.assignment_count,
      }),
      danger: true,
    })
    if (ok) deleteRoleMut.mutate(role.id)
  }

  return (
    <div className={pageCls}>
      <div className={headerCls}>
        <h1 className={titleCls}>{t('roles.title')}</h1>
        {canWrite && (
          <Button
            size="sm"
            variant="primary"
            icon={<RiAddLine size={16} />}
            onPress={() => setCreating(true)}
          >
            {t('roles.newRole')}
          </Button>
        )}
      </div>

      <div className={bodyCls}>
        <ResizablePanel
          storageKey="we-meet:admin-roles-width"
          defaultWidth={260}
          min={200}
          max={400}
        >
          <aside className={listCls}>
            {rolesFetching && roles.length === 0 ? (
              <StateHint state="loading">{t('dashboard.loading')}</StateHint>
            ) : rolesError && roles.length === 0 ? (
              <StateHint
                state="error"
                action={
                  <Button
                    variant="secondary"
                    size="dense"
                    onPress={() => void refetchRoles()}
                  >
                    {t('feedback.retry')}
                  </Button>
                }
              >
                {t('feedback.loadFailed')}
              </StateHint>
            ) : roles.length === 0 ? (
              <StateHint>{t('roles.empty')}</StateHint>
            ) : (
              roles.map((role) => (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => setSelectedId(role.id)}
                  className={rowCls(role.id === selectedId)}
                >
                  <span className={rowNameCls}>
                    {role.name}
                    {role.is_builtin && (
                      <span className={builtinTagCls}>
                        {t('roles.builtin')}
                      </span>
                    )}
                  </span>
                  <span className={rowMetaCls}>
                    {t('roles.holderCount', { count: role.assignment_count })}
                  </span>
                </button>
              ))
            )}
          </aside>
        </ResizablePanel>

        <main className={detailCls}>
          {selected === null ? (
            <PageState description={t('roles.selectRole')} />
          ) : (
            <div className={css({ padding: '1.25rem' })}>
              <div className={detailHeadCls}>
                <h2 className={detailTitleCls}>{selected.name}</h2>
                {canWrite && (
                  <Button
                    variant="secondary"
                    size="dense"
                    onPress={() => setAssigningTo(selected)}
                  >
                    {t('roles.assign')}
                  </Button>
                )}
                {/* 内置角色删不掉(服务端也拒),按钮直接不渲染。 */}
                {canWrite && !selected.is_builtin && (
                  <Button
                    variant="tertiaryText"
                    size="dense"
                    onPress={() => void removeRole(selected)}
                  >
                    {t('actions.delete')}
                  </Button>
                )}
              </div>

              <h3 className={sectionCls}>{t('roles.permissions')}</h3>
              {catalogueFetching && catalogue.length === 0 ? (
                <StateHint state="loading">{t('dashboard.loading')}</StateHint>
              ) : catalogueError && catalogue.length === 0 ? (
                <StateHint
                  state="error"
                  action={
                    <Button
                      variant="secondary"
                      size="dense"
                      onPress={() => void refetchCatalogue()}
                    >
                      {t('feedback.retry')}
                    </Button>
                  }
                >
                  {t('feedback.loadFailed')}
                </StateHint>
              ) : (
                byGroup.map(([group, entries]) => (
                  <div key={group} className={groupCls}>
                    <div className={groupTitleCls}>
                      {t(`roles.group.${group}`, { defaultValue: group })}
                    </div>
                    {entries.map((entry) => (
                      <label key={entry.code} className={checkRowCls}>
                        <input
                          type="checkbox"
                          checked={selected.permissions.includes(entry.code)}
                          disabled={!canWrite || permissionMut.isPending}
                          onChange={() =>
                            togglePermission(selected, entry.code)
                          }
                        />
                        <span className={checkLabelCls}>{entry.label}</span>
                        <code className={codeCls}>{entry.code}</code>
                      </label>
                    ))}
                  </div>
                ))
              )}

              <h3 className={sectionCls}>
                {t('roles.holders')} ({selected.assignment_count})
              </h3>
              {assignmentsFetching && assignments.length === 0 ? (
                <StateHint state="loading">{t('dashboard.loading')}</StateHint>
              ) : assignmentsError && assignments.length === 0 ? (
                <StateHint
                  state="error"
                  action={
                    <Button
                      variant="secondary"
                      size="dense"
                      onPress={() => void refetchAssignments()}
                    >
                      {t('feedback.retry')}
                    </Button>
                  }
                >
                  {t('feedback.loadFailed')}
                </StateHint>
              ) : assignments.length === 0 ? (
                <StateHint>{t('roles.noHolders')}</StateHint>
              ) : (
                <ul
                  className={css({ listStyle: 'none', margin: 0, padding: 0 })}
                >
                  {assignments.map((a) => (
                    <li key={a.id} className={holderRowCls}>
                      <span className={css({ color: 'greyscale.900' })}>
                        {a.member_name}
                      </span>
                      <span className={scopeCls}>
                        {a.scope_type === 'all'
                          ? t('roles.scopeAll')
                          : a.departments.map((d) => d.name).join('、')}
                      </span>
                      {canWrite && (
                        <button
                          type="button"
                          title={t('roles.unassign')}
                          aria-label={t('roles.unassign')}
                          onClick={() => unassignMut.mutate(a.id)}
                          className={removeBtnCls}
                        >
                          <RiDeleteBinLine size={15} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </main>
      </div>

      <RoleCreateDialog
        isOpen={creating}
        grantable={grantable}
        onDone={() => {
          invalidate()
          setCreating(false)
        }}
        onClose={() => setCreating(false)}
      />

      <RoleAssignDialog
        role={assigningTo}
        onDone={() => {
          invalidate()
          setAssigningTo(null)
        }}
        onClose={() => setAssigningTo(null)}
      />
    </div>
  )
}

const pageCls = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
})
const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1.25rem',
  paddingY: '0.875rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const bodyCls = css({
  flex: 1,
  display: 'flex',
  minHeight: 0,
  overflow: 'hidden',
})
const listCls = css({
  width: '100%',
  height: '100%',
  borderRight: '1px solid token(colors.greyscale.200)',
  overflowY: 'auto',
  backgroundColor: 'greyscale.50',
})
const detailCls = css({ flex: 1, minWidth: 0, overflowY: 'auto' })
const rowBase = {
  width: '100%',
  display: 'block',
  textAlign: 'left',
  paddingX: '1rem',
  paddingY: '0.5rem',
  border: 'none',
  cursor: 'pointer',
} as const
const rowIdle = css({
  ...rowBase,
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'greyscale.100' },
})
const rowActive = css({
  ...rowBase,
  backgroundColor: 'selected.bg',
  _hover: { backgroundColor: 'selected.bg' },
})
const rowCls = (active: boolean) => (active ? rowActive : rowIdle)
const rowNameCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.875rem',
  color: 'greyscale.900',
})
const rowMetaCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const builtinTagCls = css({
  fontSize: '0.6875rem',
  paddingX: '0.25rem',
  borderRadius: '0.25rem',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.600',
  border: '1px solid token(colors.greyscale.300)',
})
const detailHeadCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.75rem',
})
const detailTitleCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const sectionCls = css({
  marginTop: '1.25rem',
  marginBottom: '0.5rem',
  fontSize: '0.875rem',
  fontWeight: 'bold',
  color: 'greyscale.800',
})
const groupCls = css({ marginBottom: '0.75rem' })
const groupTitleCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  marginBottom: '0.25rem',
})
const checkRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingY: '0.25rem',
  fontSize: '0.8125rem',
  cursor: 'pointer',
})
const checkLabelCls = css({ color: 'greyscale.900' })
const codeCls = css({
  fontFamily: 'monospace',
  fontSize: '0.6875rem',
  color: 'greyscale.400',
})
const holderRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  paddingY: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  fontSize: '0.875rem',
})
const scopeCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.75rem',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const removeBtnCls = css({
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  _hover: { color: 'danger.subtle-text' },
})
