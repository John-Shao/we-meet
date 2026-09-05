import { SelectCompat } from '@/primitives/SelectCompat'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Button, Input } from '@/primitives'
import { Dialog } from '@/primitives/Dialog'
import { StateHint } from '@/components/StateHint'

import {
  type AdminMember,
  type OffboardInput,
  fetchAdminMembers,
  fetchOwnedResources,
} from '../api/adminMembers'

interface Props {
  member: AdminMember | null
  submitting: boolean
  onSubmit: (input: OffboardInput) => void
  onClose: () => void
}

/**
 * Confirm offboarding, after showing what the person would leave behind.
 *
 * The inventory is the point: an admin who cannot see that this member heads a
 * department and has four direct reports will discover it afterwards, when an
 * approval silently has nowhere to route.
 */
export const OffboardDialog = ({
  member,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [reason, setReason] = useState('')
  const [successor, setSuccessor] = useState('')

  const {
    data: owned,
    isLoading,
    isError: ownedError,
    refetch: refetchOwned,
  } = useQuery({
    queryKey: ['admin', 'owned-resources', member?.id],
    queryFn: () => fetchOwnedResources(member!.id),
    enabled: member !== null,
  })
  const {
    data: candidates,
    isFetching: candidatesFetching,
    isError: candidatesError,
    refetch: refetchCandidates,
  } = useQuery({
    queryKey: ['admin', 'members', 'manager-candidates'],
    queryFn: () => fetchAdminMembers({ status: 'active' }),
    staleTime: 60_000,
    enabled: member !== null,
  })

  if (!member) return null

  const name =
    member.full_name || member.short_name || member.email || member.sub || ''
  const headsDepartments = (owned?.headed_departments.length ?? 0) > 0
  const successorOptions = (candidates?.results ?? []).filter(
    (m) => m.id !== member.id
  )

  return (
    <Dialog
      isOpen={member !== null}
      type="flex"
      title={t('members.offboardTitle', { name })}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div className={contentCls}>
        <p className={explainCls}>{t('members.offboardExplain')}</p>

        {isLoading ? (
          <StateHint className={inventoryStateCls} state="loading">
            {t('members.loadingResources')}
          </StateHint>
        ) : ownedError && !owned ? (
          <StateHint
            className={inventoryStateCls}
            state="error"
            action={
              <Button
                variant="secondary"
                size="dense"
                onPress={() => void refetchOwned()}
              >
                {t('feedback.retry')}
              </Button>
            }
          >
            {t('feedback.loadFailed')}
          </StateHint>
        ) : (
          owned && (
            <ul className={inventoryCls}>
              {headsDepartments && (
                <li className={warnItemCls}>
                  {t('members.headsDepartments', {
                    names: owned.headed_departments
                      .map((d) => d.name)
                      .join('、'),
                  })}
                </li>
              )}
              {owned.direct_reports_count > 0 && (
                <li>
                  {t('members.hasReports', {
                    count: owned.direct_reports_count,
                  })}
                </li>
              )}
              {owned.owned_rooms > 0 && (
                <li>{t('members.ownsRooms', { count: owned.owned_rooms })}</li>
              )}
              {owned.owned_recordings > 0 && (
                <li>
                  {t('members.ownsRecordings', {
                    count: owned.owned_recordings,
                  })}
                </li>
              )}
            </ul>
          )
        )}

        {/* Only asked when it actually applies — the backend refuses without
            either a successor or an explicit opt-out. */}
        {headsDepartments && (
          <div className={fieldCls}>
            <span className={labelCls}>{t('members.transferHeadTo')}</span>
            {candidatesFetching && !candidates ? (
              <StateHint className={fieldStateCls} state="loading">
                {t('dashboard.loading')}
              </StateHint>
            ) : candidatesError && !candidates ? (
              <StateHint
                className={fieldStateCls}
                state="error"
                action={
                  <Button
                    variant="secondary"
                    size="dense"
                    onPress={() => void refetchCandidates()}
                  >
                    {t('feedback.retry')}
                  </Button>
                }
              >
                {t('feedback.loadFailed')}
              </StateHint>
            ) : (
              <SelectCompat
                value={successor}
                aria-label={t('members.transferHeadTo')}
                onChange={(e) => setSuccessor(e.target.value)}
              >
                <option value="">{t('members.leaveHeadless')}</option>
                {successorOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name || m.email || m.id}
                  </option>
                ))}
              </SelectCompat>
            )}
          </div>
        )}

        <label className={fieldCls}>
          <span className={labelCls}>{t('members.leaveReason')}</span>
          <Input
            value={reason}
            aria-label={t('members.leaveReason')}
            onChange={(e) => setReason(e.target.value)}
            maxLength={64}
          />
        </label>

        <div className={actionsCls}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            isDisabled={submitting}
            loading={submitting}
            onPress={() =>
              onSubmit({
                reason,
                transfer_head_to: successor || null,
                // Choosing "leave headless" in the dropdown is the explicit
                // opt-out the backend requires.
                allow_orphan_head: headsDepartments && !successor,
              })
            }
          >
            {t('members.offboardConfirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const contentCls = css({ width: 'min(26rem, calc(100vw - 6rem))' })
const explainCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  marginBottom: '0.75rem',
})
const inventoryStateCls = css({ padding: 'md', marginBottom: 'sm' })
const inventoryCls = css({
  listStyle: 'disc',
  paddingLeft: '1.25rem',
  marginBottom: '0.875rem',
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  '& li': { marginBottom: '0.25rem' },
})
const warnItemCls = css({ color: 'danger.subtle-text', fontWeight: '500' })
const fieldCls = css({
  display: 'block',
  marginBottom: '0.75rem',
})
const labelCls = css({
  display: 'block',
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  marginBottom: '0.25rem',
})
const fieldStateCls = css({
  alignItems: 'flex-start',
  padding: 'sm',
  textAlign: 'left',
})
const actionsCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '1rem',
})
