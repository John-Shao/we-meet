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
        gap: 'sm',
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
          color: 'text.link',
          borderRadius: 'field',
          padding: 'xxs xs',
          textStyle: 'labelMedium',
          _hover: { backgroundColor: 'surface.canvas' },
          _focusVisible: { outline: '2px solid token(colors.border.focus)' },
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
        gap: 'sm',
        margin: 'sm 0',
        padding: 'md',
        borderRadius: 'card',
        border: '1px solid token(colors.border.subtle)',
        backgroundColor: 'surface.canvas',
      })}
    >
      <span
        className={css({ display: 'flex', gap: 'sm', alignItems: 'center' })}
      >
        <label
          className={css({ display: 'flex', gap: 'sm', alignItems: 'center' })}
        >
          <span
            className={css({
              color: 'text.secondary',
              textStyle: 'labelMedium',
            })}
          >
            {t('speakerAttribution.search')}
          </span>
          <input
            disabled={attribute.isPending}
            maxLength={80}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className={css({
              border: '1px solid token(colors.border.subtle)',
              borderRadius: 'control',
              padding: 'xs sm',
              // 此前写死 `white`:深色主题下输入文字继承翻转后的 text.primary
              // (#E2E2E5),压在纯白底上只有约 1.3:1 —— 远低于 4.5:1。
              // 底与前景成对取语义角色,两套主题都成立。
              backgroundColor: 'surface.default',
              color: 'text.primary',
              _disabled: { color: 'text.disabled' },
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
      {candidates.isError && (
        <span role="alert">{t('speakerAttribution.loadError')}</span>
      )}
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
      {attribute.isError && (
        <span role="alert">{t('speakerAttribution.failed')}</span>
      )}
    </span>
  )
}
