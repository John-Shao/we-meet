import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import { useRenameMeetingRecord } from '../api/fetchMeetingRecord'

/**
 * Rename an ended standalone recording, mirroring the Android action
 * (`RecordRename.kt`). The backend gates this on `capabilities.rename`
 * (owner + standalone/upload + not ongoing) and guards the write with the title
 * the caller last saw, so a 409 means somebody else renamed it first — we must
 * say so rather than silently retrying with the stale value.
 */
export function RecordRenameControl({
  viewerId,
  recordId,
  title,
  onRenamed,
}: {
  viewerId: string
  recordId: string
  title: string
  onRenamed?: (title: string) => void
}) {
  const { t } = useTranslation('meetings')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  const rename = useRenameMeetingRecord(viewerId, recordId)

  useEffect(() => {
    if (open) input.current?.select()
  }, [open])

  const trimmed = draft.trim()
  const disabled =
    rename.isPending || trimmed.length === 0 || trimmed === title.trim()
  const conflict =
    rename.error instanceof ApiError && rename.error.statusCode === 409

  const close = () => {
    rename.reset()
    setOpen(false)
    setDraft(title)
  }

  if (!open)
    return (
      <Button
        size="dense"
        variant="secondaryText"
        onPress={() => {
          setDraft(title)
          setOpen(true)
        }}
      >
        {t('library.rename')}
      </Button>
    )

  return (
    <form
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
        alignItems: 'flex-start',
      })}
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled) return
        rename.mutate(
          { title: trimmed, expected_title: title },
          {
            onSuccess: (record) => {
              onRenamed?.(record.title)
              setOpen(false)
            },
          }
        )
      }}
    >
      <label
        className={css({
          display: 'flex',
          gap: 'sm',
          alignItems: 'center',
          flexWrap: 'wrap',
        })}
      >
        <span className={css({ color: 'text.secondary' })}>
          {t('library.rename')}
        </span>
        <input
          ref={input}
          aria-label={t('library.rename')}
          value={draft}
          maxLength={500}
          disabled={rename.isPending}
          onChange={(event) => {
            setDraft(event.target.value)
            if (rename.error) rename.reset()
          }}
          className={css({
            border: '1px solid token(colors.border.subtle)',
            borderRadius: 'card',
            padding: 'sm md',
            backgroundColor: 'transparent',
            minWidth: '16rem',
          })}
        />
      </label>
      <div className={css({ display: 'flex', gap: 'sm' })}>
        <Button type="submit" size="dense" isDisabled={disabled}>
          {t(rename.isPending ? 'library.renaming' : 'library.renameSave')}
        </Button>
        <Button
          type="button"
          size="dense"
          variant="secondaryText"
          isDisabled={rename.isPending}
          onPress={close}
        >
          {t('library.renameCancel')}
        </Button>
      </div>
      {rename.isError && (
        <p role="alert" className={css({ color: 'status.danger' })}>
          {t(conflict ? 'library.renameConflict' : 'library.renameError')}
        </p>
      )}
    </form>
  )
}
