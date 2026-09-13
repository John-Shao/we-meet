import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Link } from 'wouter'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { useInterpretation } from '../interpretationContext'
import type { InterpretationLanguage } from '../interpretationEvents'

export function InterpretationPanel() {
  const state = useInterpretation()
  const [save, setSave] = useState({ zh: false, en: false })
  const { t } = useTranslation('meetings', { keyPrefix: 'interpretation' })
  if (!state?.visible) return <Text>{t('unavailable')}</Text>
  const speakers = [...new Set(state.rows.map((row) => row.sourceSid))]
  return (
    <section
      aria-label={t('title')}
      className={css({
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        minWidth: 0,
      })}
    >
      <Text variant="note">{t('scope')}</Text>
      <fieldset
        className={css({
          minWidth: 0,
          border: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        })}
      >
        <legend>{t('listen')}</legend>
        {(['zh', 'en'] as InterpretationLanguage[]).map((target) => {
          const channel = state.channels.find((row) => row.target === target)
          const selected = !!channel && state.listening === channel.id
          return (
            <div
              key={target}
              className={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                padding: '0.75rem',
                borderWidth: '1px',
                borderColor: 'border.default',
                borderRadius: 'control',
              })}
            >
              <Text>
                {t(`language.${target}`)} ·{' '}
                {t(`state.${channel?.state ?? 'off'}`)}
              </Text>
              {state.canControl &&
                state.archiveAvailable &&
                (!channel ||
                  ['stopped', 'incomplete'].includes(channel.state)) && (
                  <label>
                    <input
                      type="checkbox"
                      checked={save[target]}
                      disabled={state.pending || state.uncertain}
                      onChange={(event) =>
                        setSave((previous) => ({
                          ...previous,
                          [target]: event.target.checked,
                        }))
                      }
                    />
                    {t('saveTranslations')}
                  </label>
                )}
              {channel?.archive_record_id && (
                <Text variant="note">
                  {t('savingTranslations')} ·{' '}
                  <Link
                    href={`/meeting/records/${channel.archive_record_id}?tab=translations`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('openTranslations')}
                  </Link>
                </Text>
              )}
              <Button
                size="sm"
                variant={selected ? 'secondary' : 'tertiary'}
                isDisabled={
                  state.pending ||
                  state.uncertain ||
                  !state.canJoin ||
                  (!selected &&
                    (!state.available ||
                      !channel ||
                      !['prepared', 'starting', 'translating'].includes(
                        channel.state
                      )))
                }
                onPress={() =>
                  void state.choose(selected ? undefined : channel)
                }
              >
                {t(selected ? 'leave' : 'join', {
                  language: t(`language.${target}`),
                })}
              </Button>
              {state.canControl && (
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={
                    state.pending ||
                    state.uncertain ||
                    channel?.state === 'stopping' ||
                    (!state.available &&
                      (!channel ||
                        ['stopped', 'incomplete'].includes(channel.state)))
                  }
                  onPress={() =>
                    void state.control(
                      target,
                      channel &&
                        ['prepared', 'starting', 'translating'].includes(
                          channel.state
                        )
                        ? 'stop'
                        : 'start',
                      save[target]
                    )
                  }
                >
                  {t(
                    channel &&
                      [
                        'prepared',
                        'starting',
                        'translating',
                        'stopping',
                      ].includes(channel.state)
                      ? 'stopChannel'
                      : 'startChannel',
                    { language: t(`language.${target}`) }
                  )}
                </Button>
              )}
            </div>
          )
        })}
      </fieldset>
      {state.listening && (
        <>
          <Text>{t(state.ready ? 'receiving' : 'connecting')}</Text>
          <Button size="sm" variant="tertiary" onPress={state.toggleSound}>
            {t(state.muted ? 'unmute' : 'mute')}
          </Button>
        </>
      )}
      {!state.canControl && <Text variant="note">{t('managerHint')}</Text>}
      {state.uncertain && (
        <Button
          size="sm"
          isDisabled={state.pending}
          onPress={() => void state.resubmit()}
        >
          {t('resubmit')}
        </Button>
      )}
      {state.error && (
        <div role="status">{t(state.uncertain ? 'uncertain' : 'error')}</div>
      )}
      <Text variant="note">{t('historyHint')}</Text>
      <div aria-label={t('text')} className={css({ wordBreak: 'break-word' })}>
        {state.rows.map((row) => (
          <article key={row.id} className={css({ paddingY: '0.5rem' })}>
            <Text variant="note">
              {state.speakerName(row.sourceSid) ||
                t('speaker', {
                  number: speakers.indexOf(row.sourceSid) + 1,
                })}{' '}
              · {t(row.final ? 'final' : 'preview')}
            </Text>
            <Text>
              {row.text}
              <span className={css({ color: 'text.secondary' })}>
                {row.stash}
              </span>
            </Text>
          </article>
        ))}
      </div>
    </section>
  )
}
