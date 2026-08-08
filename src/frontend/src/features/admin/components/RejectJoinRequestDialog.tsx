import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'

import type { JoinRequest } from '../api/adminInviteLinks'

interface Props {
  request: JoinRequest | null
  submitting?: boolean
  onSubmit: (reason: string) => void
  onClose: () => void
}

/**
 * 驳回一条加入申请。
 *
 * 理由是选填但值得给:申请人在自己那侧看得到它,一个没有理由的驳回换来的
 * 通常是第二次一模一样的申请。
 */
export const RejectJoinRequestDialog = ({
  request,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (request) setReason('')
  }, [request])

  return (
    <Dialog
      isOpen={request !== null}
      title={t('invites.rejectTitle')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!submitting) onSubmit(reason.trim())
        }}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.875rem',
          minWidth: '20rem',
        })}
      >
        <p className={css({ fontSize: '0.875rem', color: 'greyscale.700', margin: 0 })}>
          {t('invites.rejectPrompt', {
            name: request?.full_name || request?.phone || '',
          })}
        </p>
        <label
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.375rem',
            fontSize: '0.875rem',
            color: 'greyscale.700',
          })}
        >
          <span>{t('invites.rejectReason')}</span>
          <Input
            value={reason}
            maxLength={255}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className={css({ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' })}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={submitting}
            loading={submitting}
          >
            {t('invites.reject')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
