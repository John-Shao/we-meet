import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button, Input } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'
import type { MeetingRecordFilters } from '../api/ApiMeetingRecord'
import { recordDateRange } from '../recordDateRange'

export type LibraryFilterDraft = {
  scope: MeetingRecordFilters['scope']
  source: NonNullable<MeetingRecordFilters['source_type']> | ''
  from: string
  through: string
}

/** Draft changes stay local until Apply; dismissing never changes the list. */
export function MeetingLibraryFilters({
  initial,
  minutes,
  onApply,
  onClose,
}: {
  initial: LibraryFilterDraft
  minutes: boolean
  onApply: (value: LibraryFilterDraft) => void
  onClose: () => void
}) {
  const { t } = useTranslation('meetings')
  const [draft, setDraft] = useState(initial)
  const [invalid, setInvalid] = useState(false)
  const update = (value: Partial<LibraryFilterDraft>) => {
    setDraft({ ...draft, ...value })
    setInvalid(false)
  }
  return (
    <Modal
      ariaLabel={t('library.filters')}
      onClose={onClose}
      maxHeight="calc(100dvh - 2rem)"
    >
      <ModalHeader
        title={t('library.filters')}
        onClose={onClose}
        closeLabel={t('library.closeFilters')}
      />
      <ModalBody>
        <form
          id="meeting-library-filters"
          className={fields}
          onSubmit={(event) => {
            event.preventDefault()
            try {
              recordDateRange(draft.from, draft.through)
            } catch {
              setInvalid(true)
              return
            }
            onApply(draft)
          }}
        >
          <label className={field}>
            {t('library.scopeLabel')}
            <select
              className={control}
              value={draft.scope}
              onChange={(event) =>
                update({
                  scope: event.target.value as LibraryFilterDraft['scope'],
                })
              }
            >
              {(['recent', 'owned', 'participated', 'shared'] as const)
                .filter((value) => !minutes || value !== 'recent')
                .map((value) => (
                  <option key={value} value={value}>
                    {t(
                      `${minutes ? 'minutesLibrary.scope' : 'library.scope'}.${value}`
                    )}
                  </option>
                ))}
            </select>
          </label>
          <label className={field}>
            {t('library.sourceLabel')}
            <select
              className={control}
              value={draft.source}
              onChange={(event) =>
                update({
                  source: event.target.value as LibraryFilterDraft['source'],
                })
              }
            >
              <option value="">{t('library.allSources')}</option>
              {(
                ['meeting', 'recordings', 'audio_recording', 'upload'] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {t(`library.source.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t('library.createdFrom')}
            <Input
              type="date"
              className={dateControl}
              value={draft.from}
              aria-invalid={invalid || undefined}
              aria-describedby="meeting-filter-date-help"
              onChange={(event) => update({ from: event.target.value })}
            />
          </label>
          <label className={field}>
            {t('library.createdThrough')}
            <Input
              type="date"
              className={dateControl}
              value={draft.through}
              aria-invalid={invalid || undefined}
              aria-describedby="meeting-filter-date-help"
              onChange={(event) => update({ through: event.target.value })}
            />
          </label>
          <p id="meeting-filter-date-help" className={hint}>
            {t('library.dateHint')}
          </p>
          {invalid && <p role="alert">{t('library.dateError')}</p>}
        </form>
      </ModalBody>
      <ModalFooter className={css({ flexWrap: 'wrap' })}>
        <Button
          variant="secondary"
          onPress={() => {
            setDraft({
              scope: minutes ? 'owned' : 'recent',
              source: '',
              from: '',
              through: '',
            })
            setInvalid(false)
          }}
        >
          {t('library.resetFilters')}
        </Button>
        <Button type="submit" form="meeting-library-filters">
          {t('library.applyFilters')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
const fields = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 'lg',
})
const field = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  minWidth: 0,
  textStyle: 'labelLarge',
  color: 'text.secondary',
})
const control = cx(
  selectChrome,
  css({
    width: '100%',
    minWidth: 0,
  })
)
const hint = css({ textStyle: 'bodySmall', color: 'text.secondary', margin: 0 })

const dateControl = css({ width: '100%', minWidth: 0 })
