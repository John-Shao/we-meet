import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalFooter, ModalHeader } from '@/components/Modal'
import {
  ContactPicker,
  MemberAvatar,
  type DirectoryMember,
} from '@/features/contacts'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { CalendarEvent } from '../api/ApiCalendar'
import { transferCalendarEvent } from '../api/fetchCalendar'

interface Props {
  event: CalendarEvent
  onClose: () => void
  onTransferred: (event: CalendarEvent) => void
}

export const TransferEventDialog = ({
  event,
  onClose,
  onTransferred,
}: Props) => {
  const { t } = useTranslation('calendar')
  const [selected, setSelected] = useState<DirectoryMember | null>(null)
  const [selecting, setSelecting] = useState(true)
  const [keepOriginal, setKeepOriginal] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    setError('')
    try {
      onTransferred(
        await transferCalendarEvent(event.id, selected.id, keepOriginal)
      )
    } catch (reason) {
      setError(apiErrorMessage(reason))
      setSubmitting(false)
    }
  }

  if (selecting) {
    return (
      <ContactPicker
        title={t('transfer.title')}
        searchPlaceholder={t('transfer.searchPlaceholder')}
        onClose={() => {
          if (selected) setSelecting(false)
          else onClose()
        }}
        onSelect={(member) => {
          setError('')
          setSelected(member)
          setSelecting(false)
        }}
      />
    )
  }

  if (!selected) return null

  const selectedLabel =
    selected.full_name || selected.short_name || selected.email || selected.id
  const selectedSub = [selected.title, selected.department?.name]
    .filter(Boolean)
    .join(' · ')

  return (
    <Modal onClose={onClose} ariaLabel={t('transfer.title')} maxWidth="480px">
      <ModalHeader
        title={t('transfer.title')}
        onClose={onClose}
        closeLabel={t('form.cancel')}
      />

      <p className={labelCls}>{t('transfer.targetLabel')}</p>
      <button
        type="button"
        className={targetCls}
        onClick={() => setSelecting(true)}
        data-testid="transfer-event-target"
      >
        <MemberAvatar
          name={selectedLabel}
          src={selected.avatar_url}
          size="2.25rem"
        />
        <span className={targetTextCls}>
          <span className={targetNameCls}>{selectedLabel}</span>
          {selectedSub && <span className={targetSubCls}>{selectedSub}</span>}
        </span>
        <span className={targetArrowCls} aria-hidden="true">
          ›
        </span>
      </button>

      <label className={checkboxCls}>
        <input
          type="checkbox"
          checked={keepOriginal}
          onChange={(e) => setKeepOriginal(e.target.checked)}
        />
        <span>{t('transfer.keepOriginal')}</span>
      </label>
      {error && (
        <p className={errorCls} role="alert">
          {t('transfer.error', { message: error })}
        </p>
      )}

      <ModalFooter>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          isDisabled={submitting}
          onPress={() => void submit()}
          data-testid="transfer-event-confirm"
        >
          {t('transfer.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

const labelCls = css({
  margin: '0.75rem 1rem 0',
  fontSize: '0.875rem',
  color: 'greyscale.800',
})

const checkboxCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  margin: '0.75rem 1rem',
  fontSize: '0.875rem',
  color: 'greyscale.800',
  cursor: 'pointer',
})

const targetCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  width: 'calc(100% - 2rem)',
  margin: '0.5rem 1rem 0',
  padding: '0.625rem 0.75rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})

const targetTextCls = css({
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  gap: '0.125rem',
  minWidth: 0,
})

const targetNameCls = css({
  color: 'greyscale.900',
  fontWeight: 'medium',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const targetSubCls = css({
  color: 'greyscale.500',
  fontSize: '0.75rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const targetArrowCls = css({
  color: 'greyscale.500',
  fontSize: '1.25rem',
})

const errorCls = css({
  margin: '0 1rem 0.75rem',
  fontSize: '0.8125rem',
  color: 'red.600',
})
