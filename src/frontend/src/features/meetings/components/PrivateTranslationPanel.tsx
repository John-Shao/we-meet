import { useLocalParticipant } from '@livekit/components-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import {
  usePrivateTranslation,
  type TranslationOptions,
} from '../translationContext'
import type { TranslationDirection } from '../translationEvents'

export const PrivateTranslationPanel = () => {
  const state = usePrivateTranslation()
  const latest = useRef(state)
  latest.current = state
  const { isMicrophoneEnabled } = useLocalParticipant()
  const { t } = useTranslation('meetings', { keyPrefix: 'translation' })
  const [options, setOptions] = useState<TranslationOptions>({
    source: 'zh',
    target: 'en',
    mode: 'simultaneous',
    audio: true,
  })
  useEffect(() => {
    const release = () => {
      if (latest.current?.held) latest.current.press(latest.current.held, false)
    }
    const visibility = () => {
      if (document.hidden) release()
    }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      release()
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => {
    if (!isMicrophoneEnabled && latest.current?.held)
      latest.current.press(latest.current.held, false)
  }, [isMicrophoneEnabled])
  if (!state?.visible) return <Text>{t('unavailable')}</Text>
  const current = state.current
  const active =
    !!current && ['starting', 'translating', 'stopping'].includes(current.state)
  const selected = active ? current.configuration : options
  const languages = (value: 'zh' | 'en') => t(`language.${value}`)
  const pressButton = (direction: TranslationDirection) => {
    const language = direction === 'forward' ? selected.source : selected.target
    const held = state.held === direction
    return (
      <button
        type="button"
        aria-pressed={held}
        disabled={
          !state.ready ||
          !state.ownConnection ||
          state.error ||
          state.pending ||
          state.turnBusy ||
          !isMicrophoneEnabled ||
          current?.state !== 'translating' ||
          (!!state.held && !held)
        }
        className={css({
          padding: '0.75rem',
          borderRadius: 'control',
          borderWidth: '1px',
          borderColor: 'border.default',
          color: 'text.primary',
          backgroundColor: 'surface.default',
          touchAction: 'none',
          '&[aria-pressed=true]': { backgroundColor: 'action.selected.bg' },
          '&:disabled': { opacity: 0.5 },
        })}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId)
          state.press(direction, true)
        }}
        onPointerUp={() => state.press(direction, false)}
        onPointerCancel={() => state.press(direction, false)}
        onBlur={() => state.press(direction, false)}
        onKeyDown={(event) => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault()
            event.stopPropagation()
            state.press(direction, true)
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            state.press(direction, false)
          }
        }}
      >
        {t(held ? 'release' : 'hold', { language: languages(language) })}
      </button>
    )
  }
  return (
    <section
      aria-label={t('title')}
      className={css({
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        minWidth: 0,
      })}
    >
      <Text variant="note">{t('scope')}</Text>
      <Text>{t(`state.${current?.state ?? 'off'}`)}</Text>
      {!active ? (
        <>
          <label>
            {t('mode')}
            <select
              value={options.mode}
              disabled={state.pending || state.uncertain}
              onChange={(event) =>
                setOptions({
                  ...options,
                  mode: event.target.value as TranslationOptions['mode'],
                })
              }
            >
              <option value="simultaneous">{t('continuous')}</option>
              <option value="push_to_talk">{t('pushToTalk')}</option>
            </select>
          </label>
          <label>
            {t('source')}
            <select
              value={options.source}
              disabled={state.pending || state.uncertain}
              onChange={(event) =>
                setOptions({
                  ...options,
                  source: event.target.value as 'zh' | 'en',
                  target: event.target.value === 'zh' ? 'en' : 'zh',
                })
              }
            >
              <option value="zh">{languages('zh')}</option>
              <option value="en">{languages('en')}</option>
            </select>
          </label>
          <Text>{t('target', { language: languages(options.target) })}</Text>
          <label>
            <input
              type="checkbox"
              checked={options.audio}
              disabled={state.pending || state.uncertain}
              onChange={(event) =>
                setOptions({ ...options, audio: event.target.checked })
              }
            />
            {t('audio')}
          </label>
        </>
      ) : (
        <Text>
          {languages(selected.source)} → {languages(selected.target)} ·{' '}
          {t(selected.mode === 'push_to_talk' ? 'pushToTalk' : 'continuous')}
        </Text>
      )}
      {!isMicrophoneEnabled && <Text variant="note">{t('microphone')}</Text>}
      {active && !state.ownConnection && (
        <Text variant="note">{t('otherDevice')}</Text>
      )}
      {(active || state.available || state.uncertain) && (
        <Button
          size="sm"
          isDisabled={
            state.pending ||
            (!state.uncertain &&
              (current?.state === 'stopping' ||
                (!active && (!state.canStart || !isMicrophoneEnabled))))
          }
          onPress={() => void state.change(options)}
        >
          {t(state.uncertain ? 'resubmit' : active ? 'stop' : 'start')}
        </Button>
      )}
      {active && selected.audio && state.ownConnection && (
        <Button
          size="sm"
          variant="tertiary"
          isDisabled={current?.state === 'stopping' || state.uncertain}
          onPress={state.toggleSound}
        >
          {t(state.muted ? 'listen' : 'mute')}
        </Button>
      )}
      {active && selected.mode === 'push_to_talk' && (
        <>
          <Text variant="note">{t('pttHint')}</Text>
          {pressButton('forward')}
          {pressButton('reverse')}
          <Text>
            {t(
              state.turnBusy
                ? 'turnBusy'
                : state.ready
                  ? 'turnReady'
                  : 'connecting'
            )}
          </Text>
        </>
      )}
      {state.error && (
        <div role="status">{t(state.uncertain ? 'uncertain' : 'error')}</div>
      )}
      <Text variant="note">{t('historyHint')}</Text>
      <div aria-label={t('text')} className={css({ wordBreak: 'break-word' })}>
        {state.rows.map((row) => (
          <article key={row.id} className={css({ paddingY: '0.5rem' })}>
            <Text variant="note">
              {t(row.final ? 'final' : 'preview')} ·{' '}
              {languages(
                row.direction === 'forward' ? selected.target : selected.source
              )}
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
