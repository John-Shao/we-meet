import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import type { RecordingController } from '../capture/controller'
import { textAudioExpired } from '../capture/retention'
import {
  activeRun,
  captureTranslationApi,
  isCaptureTranslationPayload,
  type CaptureTranslationPayload,
  type CaptureTranslationSource,
  type CaptureTranslationState,
  type TranslationChoice,
} from '../capture/translationProtocol'
import {
  CaptureTranslationSocket,
  type TranslationSocketState,
} from '../capture/translationSocket'
import { TranslationPlayback } from '../capture/translationPlayback'
import { useSummaryIntent, type SummaryIntent } from '../hooks/useSummaryIntent'

/** Key by account/capture/revision. Recovered commands never reconnect a microphone. */
export function CaptureTranslationPanel({
  source,
  revision,
  controller,
}: {
  source: CaptureTranslationSource
  revision: number
  controller: RecordingController
}) {
  const { t } = useTranslation('capture')
  const validate = useCallback(
    (value: unknown): value is CaptureTranslationPayload =>
      isCaptureTranslationPayload(value, source.deviceId),
    [source.deviceId]
  )
  const intent = useSummaryIntent(
    'capture-translation',
    source.viewerId,
    source.captureId,
    validate
  )
  const [remote, setRemote] = useState<CaptureTranslationState>()
  const [live, setLive] = useState<TranslationSocketState>()
  const [choice, setChoice] = useState<TranslationChoice>({
    source_language: 'zh',
    target_language: 'en',
    mode: 'simultaneous',
    audio: false,
    save_translations: false,
  })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [muted, setMuted] = useState(false)
  const scope = useRef({ alive: false, epoch: 0, abort: new AbortController() })
  const working = useRef(false)
  const socket = useRef<CaptureTranslationSocket>()
  const socketRun = useRef<string>()
  const operations = useRef(0)
  const playback = useRef<TranslationPlayback>()

  const current = () =>
    scope.current.alive &&
    document.visibilityState === 'visible' &&
    controller.state.local?.remote?.id === source.captureId &&
    controller.state.local.remote.revision === revision &&
    controller.state.local.create.device_id === source.deviceId &&
    controller.state.local.create.lease_key === source.leaseKey
  const recording = () =>
    current() &&
    !controller.state.busy &&
    controller.state.mode === 'recording' &&
    controller.state.local?.remote?.status === 'recording' &&
    !textAudioExpired(controller.state.local)
  const api = () => {
    const epoch = scope.current.epoch
    return captureTranslationApi(
      source,
      () => current() && scope.current.epoch === epoch,
      scope.current.abort.signal
    )
  }
  const disconnect = () => {
    const consumer = socket.current
    socket.current = undefined
    socketRun.current = undefined
    consumer?.abort()
    playback.current?.close()
    playback.current = undefined
  }

  useEffect(() => {
    const lifetime = scope.current
    lifetime.alive = true
    lifetime.abort = new AbortController()
    let reading = false
    const read = async () => {
      if (reading || working.current || !current()) return
      reading = true
      const operation = operations.current
      const epoch = scope.current.epoch
      const fresh = () =>
        current() &&
        operations.current === operation &&
        scope.current.epoch === epoch
      try {
        const result = await api().read()
        if (!fresh()) return
        setRemote(result)
        setMessage('')
        const localRun = socket.current
        if (
          localRun &&
          (!activeRun(result.current) ||
            result.source.revision !== revision ||
            result.current?.id !== socketRun.current)
        ) {
          if (
            !['stopped', 'incomplete', 'unknown'].includes(localRun.state.phase)
          )
            disconnect()
        }
        if (
          localRun &&
          result.current?.id === socketRun.current &&
          result.current?.status === 'stopping'
        )
          localRun.finish()
      } catch {
        if (fresh()) {
          setRemote(undefined)
          setMessage('translation.readFailed')
          disconnect()
        }
      } finally {
        reading = false
      }
    }
    const visibility = () => {
      scope.current.epoch++
      scope.current.abort.abort()
      scope.current.abort = new AbortController()
      disconnect()
      setLive(undefined)
      setRemote(undefined)
      if (document.visibilityState === 'visible') void read()
    }
    document.addEventListener('visibilitychange', visibility)
    void read()
    const timer = window.setInterval(() => void read(), 5000)
    return () => {
      lifetime.alive = false
      lifetime.epoch++
      lifetime.abort.abort()
      document.removeEventListener('visibilitychange', visibility)
      window.clearInterval(timer)
      disconnect()
    }
    // This panel is remounted for every source/revision; command recovery stays capture-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    source.viewerId,
    source.captureId,
    source.deviceId,
    source.leaseKey,
    revision,
    controller,
  ])

  const control = async (operation: 'start' | 'stop', recover = false) => {
    if (
      working.current ||
      !current() ||
      !intent.ready ||
      (!recover && intent.pending)
    )
      return
    if (
      !recover &&
      operation === 'start' &&
      (!remote?.can_start || !recording())
    )
      return
    if (!recover && operation === 'stop' && !remote?.can_stop) return
    working.current = true
    operations.current++
    setBusy(true)
    setMessage('')
    let command: SummaryIntent<CaptureTranslationPayload> | undefined
    let output: TranslationPlayback | undefined
    const epoch = scope.current.epoch
    const valid = () => current() && scope.current.epoch === epoch
    try {
      if (!recover && operation === 'start' && choice.audio) {
        output = new TranslationPlayback()
        await output.unlock()
        if (!valid() || !recording()) throw new Error('source_changed')
      }
      command = recover
        ? intent.pending
        : intent.getOrCreate({
            device_id: source.deviceId,
            operation,
            expected_revision: revision,
            expected_run_id: remote?.current?.id ?? null,
            configuration: operation === 'start' ? choice : null,
          })
      if (!command) return
      const client = api()
      const receipt = await client.control(command)
      if (!valid()) return
      setRemote(receipt.current)
      if (!intent.resolve(command)) throw new Error('intent_storage_failed')
      const run = receipt.current.current
      if (
        !recover &&
        !receipt.replayed &&
        command.payload.operation === 'start' &&
        run?.id === receipt.command.result.id &&
        run.status === 'starting' &&
        recording()
      ) {
        const ticket = await client.ticket(run)
        if (!valid() || !recording()) return
        disconnect()
        playback.current = output
        output = undefined
        setMuted(false)
        const consumer = new CaptureTranslationSocket({
          source,
          run,
          ticket,
          authorized: () => valid() && recording(),
          observe: (listener) =>
            controller.observePcm(source.captureId, listener),
          audio: (samples) => playback.current?.play(samples),
          changed: (value) => {
            if (!valid()) return
            setLive(value)
            if (['incomplete', 'unknown'].includes(value.phase)) {
              playback.current?.close()
              playback.current = undefined
            }
          },
        })
        socket.current = consumer
        socketRun.current = run.id
        setLive(consumer.state)
        consumer.connect()
      } else setMessage('translation.reconciled')
    } catch (error) {
      if (valid()) {
        if (
          command &&
          error instanceof ApiError &&
          [400, 409, 422].includes(error.statusCode)
        )
          intent.resolve(command)
        setMessage('translation.actionFailed')
        setRemote(undefined)
        disconnect()
      }
    } finally {
      output?.close()
      working.current = false
      if (scope.current.alive) setBusy(false)
    }
  }
  const connected =
    !!live && !['stopped', 'incomplete', 'unknown'].includes(live.phase)
  const frozen =
    busy || !!intent.pending || connected || activeRun(remote?.current ?? null)
  const canStart =
    !frozen &&
    intent.ready &&
    remote?.can_start &&
    recording() &&
    (!choice.save_translations || remote.can_save_translations)
  const stop = () => {
    if (socket.current && connected && live?.phase !== 'connecting')
      socket.current.finish()
    else {
      disconnect()
      void control('stop')
    }
  }
  const spoken =
    live?.direction === 'reverse'
      ? choice.target_language
      : choice.source_language

  if (remote && !remote.available && !remote.current && !intent.pending)
    return null
  return (
    <section
      aria-label={t('translation.title')}
      className={css({
        marginTop: '1.5rem',
        padding: '1.25rem',
        border: '1px solid',
        borderColor: 'greyscale.200',
        borderRadius: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <h2 className={css({ fontWeight: 'semibold', fontSize: '1.125rem' })}>
        {t('translation.title')}
      </h2>
      <p>{t('translation.scope')}</p>
      <fieldset
        disabled={frozen}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        })}
      >
        <legend>{t('translation.settings')}</legend>
        <label>
          {t('translation.mode')}{' '}
          <select
            aria-label={t('translation.mode')}
            value={choice.mode}
            onChange={(event) =>
              setChoice({
                ...choice,
                mode: event.target.value as TranslationChoice['mode'],
              })
            }
          >
            <option value="simultaneous">
              {t('translation.simultaneous')}
            </option>
            <option value="push_to_talk">{t('translation.speech')}</option>
          </select>
        </label>{' '}
        <label>
          {t('translation.direction')}{' '}
          <select
            aria-label={t('translation.direction')}
            value={choice.source_language}
            onChange={(event) =>
              setChoice({
                ...choice,
                source_language: event.target.value === 'en' ? 'en' : 'zh',
                target_language: event.target.value === 'en' ? 'zh' : 'en',
              })
            }
          >
            <option value="zh">{t('translation.zhToEn')}</option>
            <option value="en">{t('translation.enToZh')}</option>
          </select>
        </label>
        <div>
          <label>
            <input
              type="checkbox"
              checked={choice.audio}
              onChange={(event) =>
                setChoice({ ...choice, audio: event.target.checked })
              }
            />{' '}
            {t('translation.audio')}
          </label>
        </div>
        {choice.audio && <p role="note">{t('translation.headphones')}</p>}
        <div>
          <label>
            <input
              type="checkbox"
              disabled={!remote?.can_save_translations}
              checked={choice.save_translations}
              onChange={(event) =>
                setChoice({
                  ...choice,
                  save_translations: event.target.checked,
                })
              }
            />{' '}
            {t('translation.save')}
          </label>
        </div>
      </fieldset>
      {message && <p role="alert">{t(message)}</p>}
      {intent.failed && <p role="alert">{t('translation.storageFailed')}</p>}
      {intent.pending && (
        <>
          <p>{t('translation.pending')}</p>
          <Button
            variant="secondary"
            isDisabled={busy || !intent.ready}
            onPress={() =>
              void control(intent.pending!.payload.operation, true)
            }
          >
            {t('translation.recover')}
          </Button>
        </>
      )}
      {live && <p role="status">{t(`translation.phase.${live.phase}`)}</p>}
      {!connected && activeRun(remote?.current ?? null) && (
        <p>{t('translation.detached')}</p>
      )}
      <div
        className={css({ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' })}
      >
        <Button
          variant="primary"
          isDisabled={!canStart}
          onPress={() => void control('start')}
        >
          {t('translation.start')}
        </Button>
        {(connected || remote?.can_stop) && (
          <Button
            variant="secondary"
            isDisabled={busy || !!intent.pending || live?.phase === 'finishing'}
            onPress={stop}
          >
            {t('translation.stop')}
          </Button>
        )}
        {connected && choice.audio && (
          <Button
            variant="secondary"
            onPress={() => {
              playback.current?.mute(!muted)
              setMuted(!muted)
            }}
          >
            {t(muted ? 'translation.unmute' : 'translation.mute')}
          </Button>
        )}
      </div>
      {connected && choice.mode === 'push_to_talk' && (
        <div
          className={css({ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' })}
        >
          {live?.phase === 'speaking' ? (
            <Button variant="primary" onPress={() => socket.current?.endTurn()}>
              {t('translation.endTurn', {
                language: t(`translation.${spoken}`),
              })}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                isDisabled={live?.phase !== 'ready'}
                onPress={() => socket.current?.begin('forward')}
              >
                {t('translation.speak', {
                  language: t(`translation.${choice.source_language}`),
                })}
              </Button>{' '}
              <Button
                variant="secondary"
                isDisabled={live?.phase !== 'ready'}
                onPress={() => socket.current?.begin('reverse')}
              >
                {t('translation.speak', {
                  language: t(`translation.${choice.target_language}`),
                })}
              </Button>
            </>
          )}
        </div>
      )}
      {!!live?.finals.length && (
        <ol>
          {live.finals.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ol>
      )}
      {live?.candidate && <p aria-live="off">{live.candidate.text}</p>}
    </section>
  )
}
