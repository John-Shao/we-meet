import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import { useRecordSpeakers } from '../api/fetchMeetingRecord'

/**
 * Speaker filter for an original-text read.
 *
 * The backend hands out a filter token per speaker (`id`) that is stable even
 * when two participants share a display name, so the option value is that token
 * and the visible text is only a label. The list is read per record revision:
 * a speaker can appear as soon as their first segment is published.
 */
export function SpeakerFilter({
  viewerId,
  recordId,
  revision,
  selected,
  onSelect,
}: {
  viewerId: string
  recordId: string
  revision: number
  selected: string
  onSelect: (speaker: string) => void
}) {
  const { t } = useTranslation('meetings')
  const query = useRecordSpeakers(viewerId, recordId, revision, true)
  const speakers = query.data?.results ?? []
  // Until the list lands there is nothing meaningful to filter by, and a failed
  // read must not look like "this record has no speakers".
  if (query.isError) return null
  if (speakers.length < 2 && !selected) return null
  // A selection that is no longer in the list (text was republished, or the
  // read is still in flight) must stay visible. Dropping the option would leave
  // the select unable to show its own value, stranding the user in a filtered
  // transcript with no way to see or clear which filter is applied.
  const stale = selected && !speakers.some((row) => row.id === selected)

  return (
    <div
      className={css({
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'center',
        flexWrap: 'wrap',
        margin: '0.75rem 0',
      })}
    >
      <label
        className={css({
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'center',
        })}
      >
        <span className={css({ color: 'text.secondary' })}>
          {t('library.speakerFilter')}
        </span>
        <select
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          className={css({
            border: '1px solid token(colors.greyscale.200)',
            borderRadius: '0.75rem',
            padding: '0.5rem 0.75rem',
            backgroundColor: 'transparent',
          })}
        >
          <option value="">{t('library.allSpeakers')}</option>
          {stale && (
            <option value={selected}>{t('library.unknownSpeaker')}</option>
          )}
          {speakers.map((speaker) => (
            <option key={speaker.id} value={speaker.id}>
              {speaker.identity_type === 'unknown'
                ? t('library.unknownSpeaker')
                : speaker.label}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <Button
          size="dense"
          variant="secondaryText"
          onPress={() => onSelect('')}
        >
          {t('library.clearSpeaker')}
        </Button>
      )}
    </div>
  )
}
