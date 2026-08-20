import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { DirectoryMultiPicker } from '@/features/contacts'
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
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [keepOriginal, setKeepOriginal] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, label: string) => {
    setError('')
    setSelected((current) => {
      if (current.has(id)) return new Map()
      return new Map([[id, label]])
    })
  }

  const submit = async () => {
    const newOrganizerId = selected.keys().next().value as string | undefined
    if (!newOrganizerId || submitting) return
    setSubmitting(true)
    setError('')
    try {
      onTransferred(
        await transferCalendarEvent(event.id, newOrganizerId, keepOriginal)
      )
    } catch (reason) {
      setError(apiErrorMessage(reason))
      setSubmitting(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('transfer.title')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <div className={headerCls}>
        <h2 className={titleCls}>{t('transfer.title')}</h2>
        <ModalCloseButton onClose={onClose} label={t('form.cancel')} />
      </div>

      <p className={labelCls}>{t('transfer.targetLabel')}</p>
      <DirectoryMultiPicker
        selected={selected}
        onToggle={toggle}
        labels={{
          searchPlaceholder: t('transfer.searchPlaceholder'),
          selectedTitle: t('transfer.selected', { count: selected.size }),
          loading: t('form.loading'),
          empty: t('form.noResults'),
          loadMore: t('form.loadMore'),
        }}
        searchRef={searchRef}
        searchTestId="transfer-event-search"
        testIdPrefix="transfer-event-member-"
        excludeIds={new Set([event.organizer?.id].filter(Boolean) as string[])}
      />

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

      <div className={footerCls}>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          isDisabled={selected.size !== 1 || submitting}
          onPress={() => void submit()}
          data-testid="transfer-event-confirm"
        >
          {t('transfer.confirm')}
        </Button>
      </div>
    </Modal>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

const titleCls = css({
  margin: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})

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

const errorCls = css({
  margin: '0 1rem 0.75rem',
  fontSize: '0.8125rem',
  color: 'red.600',
})

const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
