import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type {
  ApiRecordSpeaker,
  SpeakerIdentityChoice,
} from '../api/ApiMeetingRecord'
import {
  useSpeakerContacts,
  useSpeakerIdentityDecision,
} from '../api/fetchMeetingRecord'

/**
 * Say which real person a diarised track is.
 *
 * "Speaker 1" is not attribution, so a reader who knows the room needs a way to
 * record that judgement. The server keeps the recogniser's label and resolves
 * one name for every reader-facing artifact. A contact or custom label is an
 * editorial decision, independent of voiceprint enrollment.
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
          paddingY: 'xxs',
          paddingX: 'xs',
          textStyle: 'labelMedium',
          _hover: { backgroundColor: 'surface.canvas' },
          _focusVisible: { outline: '2px solid token(colors.border.focus)' },
        })}
      >
        {t(opened ? 'speakerAttribution.cancel' : 'speakerAttribution.change')}
      </button>
      {opened && (
        <Picker
          key={`${viewerId}:${recordId}:${speaker.id}`}
          recordId={recordId}
          viewerId={viewerId}
          speaker={speaker}
          onDone={() => setOpened(false)}
        />
      )}
    </span>
  )
}

function Picker({
  recordId,
  viewerId,
  speaker,
  onDone,
}: {
  recordId: string
  viewerId: string
  speaker: ApiRecordSpeaker
  onDone: () => void
}) {
  const { t } = useTranslation('meetings')
  const [text, setText] = useState('')
  // The applied query, not the input: the hook is keyed on this, so typing must
  // not refetch. Fetching per keystroke would turn a directory lookup into a
  // request storm, and `staleTime: 0` means every distinct key really does hit
  // the network.
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'contacts' | 'custom'>('contacts')
  const [kind, setKind] = useState<'all' | 'member' | 'external'>('all')
  const [department, setDepartment] = useState('')
  const [departmentOffset, setDepartmentOffset] = useState(0)
  const [offset, setOffset] = useState(0)
  const [label, setLabel] = useState(speaker.manual_label || '')
  const [expectedRevision] = useState(speaker.record_revision)
  const candidates = useSpeakerContacts(
    viewerId,
    recordId,
    {
      q: search,
      kind,
      department_id: department,
      offset,
    },
    mode === 'contacts'
  )
  const departments = useSpeakerContacts(
    viewerId,
    recordId,
    {
      kind: 'departments',
      offset: departmentOffset,
    },
    mode === 'contacts' && kind !== 'external'
  )
  const attribute = useSpeakerIdentityDecision(viewerId, recordId)
  const disabled =
    attribute.isPending ||
    expectedRevision === undefined ||
    (attribute.isError && attribute.error.statusCode === 409)
  const choose = (choice: SpeakerIdentityChoice) => {
    if (expectedRevision === undefined) return
    attribute.mutate(
      {
        speakerId: speaker.id,
        decision: {
          ...choice,
          expected_revision: expectedRevision,
        },
      },
      { onSuccess: () => onDone() }
    )
  }

  return (
    // A flyout, not a dialog: it only picks a name, and every control inside
    // stays in normal tab order.
    <span
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
        marginY: 'sm',
        marginX: 0,
        padding: 'md',
        borderRadius: 'card',
        border: '1px solid token(colors.border.subtle)',
        backgroundColor: 'surface.canvas',
      })}
    >
      <span className={css({ display: 'flex', gap: 'sm' })}>
        <button
          type="button"
          aria-pressed={mode === 'contacts'}
          disabled={attribute.isPending}
          onClick={() => setMode('contacts')}
        >
          {t('speakerAttribution.contacts')}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'custom'}
          disabled={attribute.isPending}
          onClick={() => setMode('custom')}
        >
          {t('speakerAttribution.custom')}
        </button>
      </span>
      {mode === 'custom' && (
        <>
          <label>
            {t('speakerAttribution.label')}
            <input
              maxLength={64}
              value={label}
              disabled={attribute.isPending}
              onChange={(event) => setLabel(event.target.value)}
              className={css({
                backgroundColor: 'surface.default',
                color: 'text.primary',
                border: '1px solid token(colors.border.subtle)',
                padding: 'xs',
              })}
            />
          </label>
          <Button
            size="dense"
            variant="secondaryText"
            isDisabled={disabled || !label.trim()}
            onPress={() => choose({ action: 'set_label', label: label.trim() })}
          >
            {t('speakerAttribution.saveLabel')}
          </Button>
        </>
      )}
      {mode === 'contacts' && (
        <>
          {kind !== 'member' && (
            <span className={css({ color: 'text.secondary' })}>
              {t('speakerAttribution.externalNotice')}
            </span>
          )}
          <label>
            {t('speakerAttribution.contactType')}
            <select
              value={kind}
              disabled={attribute.isPending}
              onChange={(event) => {
                setKind(event.target.value as typeof kind)
                setDepartment('')
                setOffset(0)
              }}
            >
              <option value="all">{t('speakerAttribution.allContacts')}</option>
              <option value="member">{t('speakerAttribution.members')}</option>
              <option value="external">
                {t('speakerAttribution.external')}
              </option>
            </select>
          </label>
          {kind !== 'external' && (
            <span>
              <label>
                {t('speakerAttribution.department')}
                <select
                  value={department}
                  disabled={attribute.isPending || departments.isFetching}
                  onChange={(event) => {
                    setDepartment(event.target.value)
                    setOffset(0)
                  }}
                >
                  <option value="">
                    {t('speakerAttribution.allDepartments')}
                  </option>
                  {departments.data?.results.map((item) => (
                    <option key={item.ref} value={item.ref}>
                      {item.organization_name} / {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {departmentOffset > 0 && (
                <Button
                  size="dense"
                  variant="secondaryText"
                  isDisabled={attribute.isPending || departments.isFetching}
                  onPress={() => {
                    setDepartmentOffset(Math.max(0, departmentOffset - 25))
                    setDepartment('')
                    setOffset(0)
                  }}
                >
                  {t('speakerAttribution.previousDepartments')}
                </Button>
              )}
              {departments.data?.next_offset != null && (
                <Button
                  size="dense"
                  variant="secondaryText"
                  isDisabled={attribute.isPending || departments.isFetching}
                  onPress={() => {
                    setDepartmentOffset(departments.data!.next_offset!)
                    setDepartment('')
                    setOffset(0)
                  }}
                >
                  {t('speakerAttribution.moreDepartments')}
                </Button>
              )}
              {departments.isError && !candidates.isError && (
                <span role="alert">{t('speakerAttribution.loadError')}</span>
              )}
            </span>
          )}
          <span
            className={css({
              display: 'flex',
              gap: 'sm',
              alignItems: 'center',
            })}
          >
            <label
              className={css({
                display: 'flex',
                gap: 'sm',
                alignItems: 'center',
              })}
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
                  paddingY: 'xs',
                  paddingX: 'sm',
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
              onPress={() => {
                setSearch(text.trim())
                setOffset(0)
              }}
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
                key={person.ref}
                size="dense"
                variant="secondaryText"
                // Naming the person the button applies to, not just "Choose": a row
                // of identical labels is unusable with a screen reader.
                aria-label={t('speakerAttribution.choose', {
                  name: person.name,
                })}
                isDisabled={disabled || candidates.isFetching}
                onPress={() =>
                  choose({ action: 'select_contact', contact_ref: person.ref })
                }
              >
                {person.name}
                {person.kind === 'external'
                  ? ` · ${t('speakerAttribution.external')}`
                  : [person.department_name, person.organization_name].filter(
                        Boolean
                      ).length > 0
                    ? ` · ${[person.department_name, person.organization_name].filter(Boolean).join(' / ')}`
                    : ''}
              </Button>
            ))}
          </span>
          {candidates.isFetching && (
            <span role="status">{t('speakerAttribution.loading')}</span>
          )}
          <span>
            {offset > 0 && (
              <Button
                size="dense"
                variant="secondaryText"
                isDisabled={attribute.isPending || candidates.isFetching}
                onPress={() => setOffset(Math.max(0, offset - 25))}
              >
                {t('speakerAttribution.previous')}
              </Button>
            )}
            {candidates.data?.next_offset != null && (
              <Button
                size="dense"
                variant="secondaryText"
                isDisabled={attribute.isPending || candidates.isFetching}
                onPress={() => setOffset(candidates.data!.next_offset!)}
              >
                {t('speakerAttribution.next')}
              </Button>
            )}
          </span>
        </>
      )}
      <Button
        size="dense"
        variant="secondaryText"
        isDisabled={disabled}
        onPress={() => choose({ action: 'clear' })}
      >
        {t('speakerAttribution.clear')}
      </Button>
      {expectedRevision === undefined && (
        <span role="alert">{t('speakerAttribution.changed')}</span>
      )}
      {attribute.isError && (
        <span role="alert">
          {t(
            attribute.error.statusCode === 409
              ? 'speakerAttribution.changed'
              : 'speakerAttribution.failed'
          )}
        </span>
      )}
    </span>
  )
}
