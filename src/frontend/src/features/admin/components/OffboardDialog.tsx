import { SelectCompat } from '@/primitives/SelectCompat'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css, cx } from '@/styled-system/css'
import { Button } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'

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

  const { data: owned, isLoading } = useQuery({
    queryKey: ['admin', 'owned-resources', member?.id],
    queryFn: () => fetchOwnedResources(member!.id),
    enabled: member !== null,
  })
  const { data: candidates } = useQuery({
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
    <>
      <div className={scrimCls} onClick={onClose} aria-hidden />
      <div
        className={dialogCls}
        role="dialog"
        aria-label={t('members.offboardTitle', { name })}
      >
        <h2 className={titleCls}>{t('members.offboardTitle', { name })}</h2>

        <p className={explainCls}>{t('members.offboardExplain')}</p>

        {isLoading ? (
          <p className={mutedCls}>{t('members.loadingResources')}</p>
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
          <label className={fieldCls}>
            <span className={labelCls}>{t('members.transferHeadTo')}</span>
            <SelectCompat
              value={successor}
              onChange={(e) => setSuccessor(e.target.value)}
              className={cx(inputCls, selectChrome)}
            >
              <option value="">{t('members.leaveHeadless')}</option>
              {successorOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.email || m.id}
                </option>
              ))}
            </SelectCompat>
          </label>
        )}

        <label className={fieldCls}>
          <span className={labelCls}>{t('members.leaveReason')}</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={64}
            className={inputCls}
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
    </>
  )
}

const scrimCls = css({
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.32)',
  zIndex: 'modal',
})
const dialogCls = css({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(460px, calc(100vw - 2rem))',
  padding: '1.25rem',
  borderRadius: '8px',
  backgroundColor: 'greyscale.000',
  zIndex: 'modal',
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
})
const titleCls = css({
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
  marginBottom: '0.5rem',
})
const explainCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  marginBottom: '0.75rem',
})
const mutedCls = css({ fontSize: '0.8125rem', color: 'greyscale.500' })
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
const inputCls = css({
  width: '100%',
  height: 'control.md',
  paddingX: '0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.875rem',
})
const actionsCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '1rem',
})
