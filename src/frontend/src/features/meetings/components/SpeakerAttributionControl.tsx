import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiRecordSpeaker } from '../api/ApiMeetingRecord'
import {
  useAttributionCandidates,
  useAttributeSpeaker,
} from '../api/fetchMeetingRecord'

/**
 * Say which real person a diarised track is.
 *
 * "Speaker 1" is not attribution, so a reader who knows the room needs a way to
 * record that judgement. The server keeps the recogniser's label and resolves
 * one name for every reader-facing artifact, so this control only ever chooses a
 * person — it never lets anyone rewrite what was heard.
 *
 * Offered only where the server says `can_attribute`. A plain reader, and every
 * speaker of an online meeting (those identities already are people, and that
 * source has no revision model to bind against), sees the name without a control
 * that could only fail.
 */
export function SpeakerAttributionControl({
  recordId,
  viewerId,
  speaker,
}: {
  recordId: string
  viewerId: string
  speaker: ApiRecordSpeaker
}) {
  const { t } = useTranslation('meetings')
  const [opened, setOpened] = useState(false)
  const name = speaker.display_name || speaker.label
  if (!speaker.can_attribute) return <span>{name}</span>

  return (
    <span
      className={css({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        flexWrap: 'wrap',
      })}
    >
      <span>{name}</span>
      <button
        type="button"
        aria-expanded={opened}
        aria-label={t('speakerAttribution.changeFor', { name })}
        onClick={() => setOpened((value) => !value)}
        className={css({
          cursor: 'pointer',
          color: 'primary.700',
          borderRadius: '0.25rem',
          padding: '0.125rem 0.25rem',
          textStyle: 'labelMedium',
          _hover: { backgroundColor: 'primary.100' },
          _focusVisible: { outline: '2px solid token(colors.primary.500)' },
        })}
      >
        {t(opened ? 'speakerAttribution.cancel' : 'speakerAttribution.change')}
      </button>
      {opened && (
        <Picker
          recordId={recordId}
          viewerId={viewerId}
          speakerId={speaker.id}
          onDone={() => setOpened(false)}
        />
      )}
    </span>
  )
}

function Picker({
  recordId,
  viewerId,
  speakerId,
  onDone,
}: {
  recordId: string
  viewerId: string
  speakerId: string
  onDone: () => void
}) {
  const { t } = useTranslation('meetings')
  const [text, setText] = useState('')
  // The applied query, not the input: the hook is keyed on this, so typing must
  // not refetch. Fetching per keystroke would turn a directory lookup into a
  // request storm, and `staleTime: 0` means every distinct key really does hit
  // the network.
  const [search, setSearch] = useState('')
  const candidates = useAttributionCandidates(viewerId, recordId, search, true)
  const attribute = useAttributeSpeaker(viewerId, recordId)
  const choose = (userId: string | null) =>
    attribute.mutate({ speakerId, userId }, { onSuccess: () => onDone() })

  return (
    // A flyout, not a dialog: it only picks a name, and every control inside
    // stays in normal tab order.
    <span
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        margin: '0.5rem 0',
        padding: '0.75rem',
        borderRadius: '0.75rem',
        border: '1px solid token(colors.greyscale.200)',
        backgroundColor: 'greyscale.50',
      })}
    >
      <span className={css({ display: 'flex', gap: '0.5rem', alignItems: 'center' })}>
        <label className={css({ display: 'flex', gap: '0.5rem', alignItems: 'center' })}>
          <span className={css({ color: 'text.secondary', textStyle: 'labelMedium' })}>
            {t('speakerAttribution.search')}
          </span>
          <input
            disabled={attribute.isPending}
            maxLength={80}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className={css({
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '0.5rem',
              padding: '0.25rem 0.5rem',
              backgroundColor: 'white',
            })}
          />
        </label>
        <Button
          size="dense"
          variant="secondaryText"
          isDisabled={attribute.isPending}
          onPress={() => setSearch(text.trim())}
        >
          {t('speakerAttribution.find')}
        </Button>
      </span>
      {candidates.isError && <span role="status">{t('speakerAttribution.loadError')}</span>}
      {candidates.data && !candidates.data.results.length && (
        <span className={css({ color: 'text.secondary' })}>
          {t('speakerAttribution.nobody')}
        </span>
      )}
      <span
        className={css({
          display: 'flex',
          gap: '0.375rem',
          flexWrap: 'wrap',
        })}
      >
        {candidates.data?.results.map((person) => (
          <Button
            key={person.id}
            size="dense"
            variant="secondaryText"
            // Naming the person the button applies to, not just "Choose": a row
            // of identical labels is unusable with a screen reader.
            aria-label={t('speakerAttribution.choose', { name: person.name })}
            isDisabled={attribute.isPending}
            onPress={() => choose(person.id)}
          >
            {person.name}
          </Button>
        ))}
        {/* Clearing is a real operation, not a refusal: attributing the wrong
            colleague has to be undoable, and the label is still underneath. */}
        <Button
          size="dense"
          variant="secondaryText"
          isDisabled={attribute.isPending}
          onPress={() => choose(null)}
        >
          {t('speakerAttribution.clear')}
        </Button>
      </span>
      {attribute.isError && <span role="status">{t('speakerAttribution.failed')}</span>}
    </span>
  )
}
