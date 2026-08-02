import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import {
  type OrgInvitation,
  fetchInvitations,
  revokeInvitation,
} from '../api/adminInvitations'
import { describeApiError } from '../api/errors'

/** Pending-invitation list with revoke, shown under the members "invitations" tab. */
export const InvitationsPanel = () => {
  const { t, i18n } = useTranslation('admin')
  const { confirm, alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()

  const { data, isFetching } = useQuery({
    queryKey: ['admin', 'invitations'],
    queryFn: () => fetchInvitations('pending'),
    staleTime: 15_000,
  })

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] }),
    onError: (e: unknown) => showAlert({ message: describeApiError(e) }),
  })

  const invitations = data?.results ?? []
  const roleLabel = (r: string) => t(`role.${r}`, { defaultValue: r })
  const formatDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(i18n.language || undefined, {
        dateStyle: 'medium',
      }).format(new Date(iso))
    } catch {
      return iso
    }
  }

  const revoke = async (inv: OrgInvitation) => {
    const ok = await confirm({
      message: t('invite.revokeConfirm', { name: inv.full_name || inv.phone || inv.email }),
      danger: true,
    })
    if (ok) revokeMut.mutate(inv.id)
  }

  if (isFetching && invitations.length === 0) {
    return <p className={emptyText}>{t('members.loading')}</p>
  }
  if (invitations.length === 0) {
    return <p className={emptyText}>{t('invite.noPending')}</p>
  }

  return (
    <table className={css({ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' })}>
      <thead>
        <tr className={css({ textAlign: 'left', color: 'greyscale.500', borderBottom: '1px solid token(colors.greyscale.200)' })}>
          <th className={th}>{t('members.colMember')}</th>
          <th className={th}>{t('members.colDepartment')}</th>
          <th className={th}>{t('members.colRole')}</th>
          <th className={th}>{t('invite.invitedAt')}</th>
          <th className={css({ ...thBase, width: '4rem' })} />
        </tr>
      </thead>
      <tbody>
        {invitations.map((inv) => (
          <tr
            key={inv.id}
            className={css({
              borderBottom: '1px solid token(colors.greyscale.100)',
              _hover: { backgroundColor: 'greyscale.50' },
            })}
          >
            <td className={td}>
              {inv.full_name && (
                <span className={css({ marginRight: '0.5rem' })}>{inv.full_name}</span>
              )}
              {/* 手机号在前:这才是 we-meet 的登录主键,邮箱多半是它合成出来的。 */}
              <span className={css({ color: 'greyscale.600' })}>
                {inv.phone || inv.email}
              </span>
            </td>
            <td className={td}>{inv.department?.name ?? t('members.orgLevel')}</td>
            <td className={td}>{roleLabel(inv.org_role)}</td>
            <td className={`${td} ${css({ color: 'greyscale.600', whiteSpace: 'nowrap' })}`}>
              {formatDate(inv.created_at)}
            </td>
            <td className={td}>
              <Button
                variant="secondary"
                size="dense"
                onPress={() => revoke(inv)}
                className={css({
                  // 同 Members 的 menuItemDanger:error.50 不存在(hover 底色
                  // 被丢弃),且 error 反向色阶下 error.700 是浅粉、压白底 2.35:1。
                  color: 'danger.subtle-text',
                  borderColor: 'greyscale.300',
                  _hover: { backgroundColor: 'danger.subtle' },
                })}
              >
                {t('invite.revoke')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const thBase = { paddingX: '1rem', paddingY: '0.625rem', fontWeight: '600' as const }
const th = css(thBase)
const td = css({ paddingX: '1rem', paddingY: '0.5rem', color: 'greyscale.800', verticalAlign: 'middle' })
const emptyText = css({ padding: '1.5rem', color: 'greyscale.500', fontSize: '0.9375rem' })
