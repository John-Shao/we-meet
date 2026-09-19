import { RiUser3Line } from '@remixicon/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css, cx } from '@/styled-system/css'

/**
 * One utterance.
 *
 * Editing is offered only when a caller passes `onCorrect`. A record whose
 * source has no revision model (an online meeting transcript) simply omits it,
 * so the row never shows a control that would fail — the server refuses that
 * source, and a button whose only outcome is an error is worse than no button.
 */
export function TranscriptSegment({
  speaker,
  time,
  text,
  onSeek,
  seekLabel,
  segmentId,
  active = false,
  originalText,
  isCorrected = false,
  onCorrect,
  onRevert,
  correcting = false,
  editFailed = false,
}: {
  speaker: string
  time: string
  text: string
  onSeek?: () => void
  seekLabel?: string
  /** Identifies this row to the list that scrolls it into view. */
  segmentId: string
  /**
   * True while playback is inside this row. Passed in rather than derived here
   * so the row stays a leaf: the list decides which row is active and which row
   * gets scrolled, exactly once per change.
   */
  active?: boolean
  /** What the recogniser produced, shown when it differs from `text`. */
  originalText?: string
  isCorrected?: boolean
  onCorrect?: (segmentId: string, text: string) => void
  onRevert?: (segmentId: string) => void
  correcting?: boolean
  editFailed?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [showingOriginal, setShowingOriginal] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== text && !correcting

  const startEditing = () => {
    setDraft(text)
    setShowingOriginal(false)
    setEditing(true)
  }

  const shown = showingOriginal && originalText !== undefined ? originalText : text

  return (
    <article
      // The list finds the active row by this attribute, so a filtered list can
      // simply not find it instead of needing a second source of truth.
      data-segment-id={segmentId}
      // aria-current is the accessible signal; the left rule is its visual twin.
      aria-current={active ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      data-corrected={isCorrected ? 'true' : undefined}
      className={cx(
        css({
          padding: '1.25rem 0',
          overflowWrap: 'anywhere',
          borderLeft: '3px solid transparent',
          paddingLeft: '0.75rem',
          marginLeft: '-0.75rem',
          transition: 'background-color 150ms ease',
        }),
        active &&
          css({
            backgroundColor: 'primary.50',
            borderLeftColor: 'primary.500',
          })
      )}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.625rem',
          marginBottom: '0.875rem',
          color: 'greyscale.600',
          fontSize: '0.875rem',
          flexWrap: 'wrap',
        })}
      >
        <span
          aria-hidden
          className={css({
            display: 'grid',
            placeItems: 'center',
            width: '2rem',
            height: '2rem',
            borderRadius: '50%',
            backgroundColor: 'primary.100',
            color: 'primary.600',
            flexShrink: 0,
          })}
        >
          <RiUser3Line size={17} />
        </span>
        <span>{speaker}</span>
        <span aria-hidden>·</span>
        {onSeek ? (
          <button
            type="button"
            onClick={onSeek}
            aria-label={seekLabel}
            className={css({
              cursor: 'pointer',
              color: 'primary.700',
              borderRadius: '0.25rem',
              padding: '0.25rem',
              _hover: { backgroundColor: 'primary.100' },
              _focusVisible: { outline: '2px solid token(colors.primary.500)' },
            })}
          >
            {time}
          </button>
        ) : (
          <span>{time}</span>
        )}
        {isCorrected && (
          <span
            className={css({
              padding: '0.125rem 0.5rem',
              borderRadius: '0.5rem',
              backgroundColor: 'primary.100',
              color: 'primary.700',
              fontSize: '0.75rem',
            })}
          >
            {t('transcriptCorrection.editedBadge')}
          </span>
        )}
        {isCorrected && (
          <button
            type="button"
            onClick={() => setShowingOriginal((value) => !value)}
            className={css({
              cursor: 'pointer',
              color: 'primary.700',
              textDecoration: 'underline',
              borderRadius: '0.25rem',
              padding: '0.125rem 0.25rem',
            })}
          >
            {t(
              showingOriginal
                ? 'transcriptCorrection.hideOriginal'
                : 'transcriptCorrection.showOriginal'
            )}
          </button>
        )}
        {!editing && onCorrect && (
          <button
            type="button"
            onClick={startEditing}
            className={css({
              cursor: 'pointer',
              color: 'primary.700',
              borderRadius: '0.25rem',
              padding: '0.125rem 0.25rem',
              _hover: { backgroundColor: 'primary.100' },
              _focusVisible: { outline: '2px solid token(colors.primary.500)' },
            })}
          >
            {t('transcriptCorrection.edit')}
          </button>
        )}
        {!editing && isCorrected && onRevert && (
          <button
            type="button"
            disabled={correcting}
            onClick={() => onRevert(segmentId)}
            className={css({
              cursor: 'pointer',
              color: 'primary.700',
              borderRadius: '0.25rem',
              padding: '0.125rem 0.25rem',
              _hover: { backgroundColor: 'primary.100' },
            })}
          >
            {t('transcriptCorrection.restore')}
          </button>
        )}
      </div>

      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            onCorrect?.(segmentId, trimmed)
            setEditing(false)
          }}
          className={css({ display: 'flex', flexDirection: 'column', gap: '0.5rem' })}
        >
          <textarea
            ref={input}
            aria-label={t('transcriptCorrection.edit')}
            value={draft}
            rows={3}
            maxLength={20_000}
            onChange={(event) => setDraft(event.target.value)}
            className={css({
              width: '100%',
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '0.5rem',
              padding: '0.75rem',
              fontSize: '1rem',
              lineHeight: 1.7,
              backgroundColor: 'transparent',
              resize: 'vertical',
            })}
          />
          <div className={css({ display: 'flex', gap: '0.5rem' })}>
            <Button type="submit" size="sm" isDisabled={!canSave}>
              {t(
                correcting
                  ? 'transcriptCorrection.saving'
                  : 'transcriptCorrection.save'
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondaryText"
              isDisabled={correcting}
              onPress={() => setEditing(false)}
            >
              {t('transcriptCorrection.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <p
          className={css({
            whiteSpace: 'pre-wrap',
            fontSize: '1rem',
            lineHeight: 1.9,
            color: 'greyscale.900',
          })}
        >
          {shown}
        </p>
      )}

      {editFailed && (
        <p role="alert" className={css({ color: 'text.error', marginTop: '0.5rem' })}>
          {t('transcriptCorrection.failed')}
        </p>
      )}
    </article>
  )
}
