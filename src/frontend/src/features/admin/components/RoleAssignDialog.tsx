import { SelectCompat } from '@/primitives/SelectCompat'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'
import { StateHint } from '@/components/StateHint'

import { type AdminRole, createRoleAssignment } from '../api/adminRoles'
import { fetchAdminDepartments } from '../api/adminDepartments'
import { fetchAdminMembers } from '../api/adminMembers'
import { describeRoleError } from '../api/errors'

interface Props {
  /** null = closed. */
  role: AdminRole | null
  onDone: () => void
  onClose: () => void
}

/**
 * 把角色授予某个成员,可选择限定到若干部门。
 *
 * 两个 UI 决定对着服务端的两条校验:
 * - 授权对象是 **membership id** 而不是 user id —— 管理权限挂在组织关系上。
 * - 选了「按部门」就必须至少勾一个部门:服务端会 400,因为一个不含任何部门的
 *   部门级授权谁都管不到,而那种管理员只会打开管理台发现一片空白然后来报 bug。
 */
export const RoleAssignDialog = ({ role, onDone, onClose }: Props) => {
  const { t } = useTranslation('admin')
  const { alert: showAlert } = useConfirm()
  const [membership, setMembership] = useState('')
  const [scopeType, setScopeType] = useState<'all' | 'departments'>('all')
  const [departmentIds, setDepartmentIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (role) {
      setMembership('')
      setScopeType('all')
      setDepartmentIds(new Set())
    }
  }, [role])

  const {
    data: memberPage,
    isFetching: membersFetching,
    isError: membersError,
    refetch: refetchMembers,
  } = useQuery({
    queryKey: ['admin', 'members', { forRoleAssign: true }],
    queryFn: () => fetchAdminMembers({ status: 'active' }),
    enabled: role !== null,
    staleTime: 60_000,
  })
  const {
    data: departments = [],
    isFetching: departmentsFetching,
    isError: departmentsError,
    refetch: refetchDepartments,
  } = useQuery({
    queryKey: ['admin', 'departments'],
    queryFn: fetchAdminDepartments,
    enabled: role !== null,
    staleTime: 60_000,
  })

  const assignMut = useMutation({
    mutationFn: () =>
      createRoleAssignment({
        role: role!.id,
        membership,
        scope_type: scopeType,
        department_ids: scopeType === 'departments' ? [...departmentIds] : [],
      }),
    onSuccess: onDone,
    onError: (e: unknown) => showAlert({ message: describeRoleError(t, e) }),
  })

  const members = memberPage?.results ?? []
  const canSubmit =
    membership !== '' &&
    (scopeType === 'all' || departmentIds.size > 0) &&
    !assignMut.isPending

  const toggleDepartment = (id: string) => {
    setDepartmentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    // type="flex" 让外框跟着内容宽走。默认的 dialog 档是**定宽 30rem**,内容一旦
    // 比 30rem − 3rem 内边距宽,超出的部分不会撑框也不会裁剪,而是整片露到白框
    // 外面(下拉框漂在遮罩上)。宽对话框都得走这一档。
    <Dialog
      isOpen={role !== null}
      onClose={onClose}
      type="flex"
      title={t('roles.assignTitle', { name: role?.name ?? '' })}
    >
      <div className={css({ width: 'min(32rem, calc(100vw - 6rem))' })}>
        <div className={fieldCls}>
          <span className={labelCls}>{t('roles.member')}</span>
          <span className={controlCls}>
            {membersFetching && members.length === 0 ? (
              <StateHint className={fieldStateCls} state="loading">
                {t('dashboard.loading')}
              </StateHint>
            ) : membersError && members.length === 0 ? (
              <StateHint
                className={fieldStateCls}
                state="error"
                action={
                  <Button
                    variant="secondary"
                    size="dense"
                    onPress={() => void refetchMembers()}
                  >
                    {t('feedback.retry')}
                  </Button>
                }
              >
                {t('feedback.loadFailed')}
              </StateHint>
            ) : members.length === 0 ? (
              <StateHint className={fieldStateCls}>
                {t('roles.noMembers')}
              </StateHint>
            ) : (
              <SelectCompat
                value={membership}
                aria-label={t('roles.member')}
                onChange={(e) => setMembership(e.target.value)}
              >
                <option value="">{t('roles.pickMember')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name || m.short_name || m.email}
                  </option>
                ))}
              </SelectCompat>
            )}
          </span>
        </div>

        <div className={fieldCls}>
          <span className={labelCls}>{t('roles.scope')}</span>
          <span className={controlCls}>
            <SelectCompat
              value={scopeType}
              aria-label={t('roles.scope')}
              onChange={(e) =>
                setScopeType(e.target.value as 'all' | 'departments')
              }
            >
              <option value="all">{t('roles.scopeAll')}</option>
              <option value="departments">{t('roles.scopeDepartments')}</option>
            </SelectCompat>
          </span>
        </div>

        {scopeType === 'departments' && (
          <>
            {/* 范围按**子树**生效,勾一个父部门就覆盖它下面所有层级。 */}
            <p className={hintCls}>{t('roles.scopeSubtreeHint')}</p>
            <div className={listCls}>
              {departmentsFetching && departments.length === 0 ? (
                <StateHint className={listStateCls} state="loading">
                  {t('dashboard.loading')}
                </StateHint>
              ) : departmentsError && departments.length === 0 ? (
                <StateHint
                  className={listStateCls}
                  state="error"
                  action={
                    <Button
                      variant="secondary"
                      size="dense"
                      onPress={() => void refetchDepartments()}
                    >
                      {t('feedback.retry')}
                    </Button>
                  }
                >
                  {t('feedback.loadFailed')}
                </StateHint>
              ) : departments.length === 0 ? (
                <StateHint className={listStateCls}>
                  {t('roles.noDepartments')}
                </StateHint>
              ) : (
                departments.map((d) => (
                  <Checkbox
                    key={d.id}
                    size="sm"
                    className={departmentCheckboxCls}
                    isSelected={departmentIds.has(d.id)}
                    onChange={() => toggleDepartment(d.id)}
                  >
                    <span
                      style={{ paddingLeft: `${d.depth * 0.875}rem` }}
                      className={css({ color: 'text.primary' })}
                    >
                      {d.name}
                    </span>
                  </Checkbox>
                ))
              )}
            </div>
          </>
        )}

        <div className={footerCls}>
          <Button variant="tertiaryText" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={!canSubmit}
            loading={assignMut.isPending}
            onPress={() => assignMut.mutate()}
          >
            {t('roles.assign')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const fieldCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  marginBottom: '0.5rem',
})
const labelCls = css({
  width: '4.5rem',
  flexShrink: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})
const controlCls = css({ flex: 1, minWidth: 0 })
const fieldStateCls = css({
  alignItems: 'flex-start',
  padding: 'sm',
  textAlign: 'left',
})
const hintCls = css({
  marginLeft: '5.25rem',
  marginBottom: '0.25rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const listCls = css({
  maxHeight: '14rem',
  overflowY: 'auto',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '6px',
  padding: '0.5rem',
})
const departmentCheckboxCls = css({
  paddingY: '0.25rem',
  textStyle: 'bodySmall',
  color: 'text.primary',
})
const listStateCls = css({ padding: 'md' })
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.75rem',
})
