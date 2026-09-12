import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Redirect } from 'wouter'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { CaptureJournal, type LocalAudioChunk } from '../capture/journal'
import {
  RecordingController,
  type CaptureViewState,
} from '../capture/controller'
import { withCaptureLock } from '../capture/microphone'
import { captureTransport } from '../capture/transport'
import { CaptureAudioPlayer } from '../components/CaptureAudioPlayer'

const duration = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function Recorder({
  viewerId,
  available,
}: {
  viewerId: string
  available: boolean
}) {
  const { t } = useTranslation('capture')
  const [controller, setController] = useState<RecordingController>()
  const [state, setState] = useState<CaptureViewState>({
    history: [],
    mode: 'ready',
    busy: true,
  })
  const [unavailable, setUnavailable] = useState(false)
  const [title, setTitle] = useState('')
  const [localChunks, setLocalChunks] = useState<LocalAudioChunk[]>([])
  const [localPage, setLocalPage] = useState(0)

  useEffect(() => {
    let cancelled = false
    let active: RecordingController | undefined
    const abort = new AbortController()
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    void withCaptureLock(viewerId, async () => {
      const journal = await CaptureJournal.open(viewerId)
      try {
        if (cancelled) return
        active = new RecordingController(
          journal,
          captureTransport(abort.signal),
          setState
        )
        await active.load()
        if (cancelled) return
        setController(active)
        await released
      } finally {
        active?.dispose()
        journal.close()
      }
    }).catch(() => {
      if (!cancelled) setUnavailable(true)
    })
    return () => {
      cancelled = true
      active?.dispose()
      abort.abort()
      release()
    }
  }, [viewerId])

  useEffect(() => {
    setLocalChunks([])
    setLocalPage(0)
  }, [state.local?.id, state.local?.pendingBytes])

  useEffect(() => {
    if (!state.local || state.local.sealed) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [state.local])

  const local = state.local
  const working = !!local && !local.sealed
  const canResume =
    working &&
    state.mode !== 'recording' &&
    !local.sealIntent &&
    local.remote?.status !== 'stopping' &&
    local.remote?.status !== 'stopped'
  const disabled = !controller || state.busy || unavailable
  const download = (chunk: LocalAudioChunk) => {
    if (!chunk.audio) return
    const url = URL.createObjectURL(
      new Blob([chunk.audio], { type: 'audio/wav' })
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `recording-part-${chunk.sequence}.wav`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Screen>
      <main
        className={css({
          width: '100%',
          maxWidth: '54rem',
          margin: '0 auto',
          padding: '1.5rem',
          overflowY: 'auto',
        })}
      >
        <a href="/meeting">{t('back')}</a>
        <h1
          className={css({
            fontSize: '1.5rem',
            fontWeight: 'bold',
            marginTop: '1rem',
          })}
        >
          {t('title')}
        </h1>
        <p>{t('scope')}</p>
        <p className={css({ color: 'greyscale.600', marginBottom: '1.5rem' })}>
          {t('leaveHint')}
        </p>
        {unavailable && <p role="alert">{t('unavailable')}</p>}
        {!available && <p role="status">{t('disabled')}</p>}
        <section
          className={css({
            padding: '1.25rem',
            border: '1px solid',
            borderColor: 'greyscale.200',
            borderRadius: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          })}
        >
          {working ? (
            <h2>{local.create.title || t('untitled')}</h2>
          ) : (
            <label>
              {t('name')}
              <input
                aria-label={t('name')}
                maxLength={500}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className={css({
                  display: 'block',
                  width: '100%',
                  padding: '0.625rem',
                  border: '1px solid',
                  borderColor: 'greyscale.300',
                  borderRadius: '0.5rem',
                })}
              />
            </label>
          )}
          <p role="status" aria-live="polite">
            {t(`state.${state.mode}`)}
            {state.busy ? ` · ${t('busy')}` : ''}
          </p>
          {local && (
            <p>
              {t('duration', { value: duration(local.durationMs) })} ·{' '}
              {t('pending', {
                value: (local.pendingBytes / 1048576).toFixed(1),
              })}
            </p>
          )}
          {local?.interrupted && <p role="note">{t('interrupted')}</p>}
          {local?.remote?.media_status === 'incomplete' && (
            <p role="note">{t('incomplete')}</p>
          )}
          {state.error && <p role="alert">{t(state.error)}</p>}
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
            })}
          >
            {!working && (
              <Button
                variant="primary"
                isDisabled={disabled || !available}
                onPress={() => void controller?.start(title)}
              >
                {t('start')}
              </Button>
            )}
            {canResume && (
              <Button
                variant="primary"
                isDisabled={disabled || !available}
                onPress={() => void controller?.start(title)}
              >
                {t('resume')}
              </Button>
            )}
            {state.mode === 'recording' && (
              <Button
                variant="secondary"
                isDisabled={disabled}
                onPress={() => void controller?.pause()}
              >
                {t('pause')}
              </Button>
            )}
            {working && (
              <Button
                variant="secondary"
                isDisabled={disabled}
                onPress={() => void controller?.finish()}
              >
                {t('finish')}
              </Button>
            )}
            {working && !!local.pendingBytes && (
              <Button
                variant="secondary"
                isDisabled={disabled}
                onPress={() => void controller?.retryUploads()}
              >
                {t('retry')}
              </Button>
            )}
          </div>
          {working && state.mode !== 'recording' && !!state.error && (
            <details>
              <summary>{t('cannotUpload')}</summary>
              <p>{t('partialHint')}</p>
              <Button
                variant="secondary"
                isDisabled={disabled}
                onPress={() => void controller?.finish(true)}
              >
                {t('finishPartial')}
              </Button>
            </details>
          )}
        </section>
        {local?.sealed && local.remote && (
          <CaptureAudioPlayer
            key={`${viewerId}:${local.remote.id}`}
            captureId={local.remote.id}
          />
        )}
        {!!local?.pendingBytes && (
          <section className={css({ marginTop: '1.5rem' })}>
            <h2>{t('localAudio')}</h2>
            <p>{t('localHint')}</p>
            <Button
              variant="secondary"
              isDisabled={disabled}
              onPress={() => {
                void controller
                  ?.localAudio()
                  .then(setLocalChunks)
                  .catch(() => setUnavailable(true))
              }}
            >
              {t('showLocal')}
            </Button>
            <ul>
              {localChunks
                .slice(localPage * 10, localPage * 10 + 10)
                .map((chunk) => (
                  <li key={chunk.sequence}>
                    <Button variant="secondary" onPress={() => download(chunk)}>
                      {t('downloadPart', {
                        number: chunk.sequence,
                        time: duration(chunk.start_ms),
                      })}
                    </Button>
                  </li>
                ))}
            </ul>
            {localPage > 0 && (
              <Button
                variant="secondary"
                onPress={() => setLocalPage((page) => page - 1)}
              >
                {t('previous')}
              </Button>
            )}
            {(localPage + 1) * 10 < localChunks.length && (
              <Button
                variant="secondary"
                onPress={() => setLocalPage((page) => page + 1)}
              >
                {t('next')}
              </Button>
            )}
          </section>
        )}
        {!!state.history.length && (
          <section className={css({ marginTop: '1.5rem' })}>
            <h2>{t('history')}</h2>
            <ul>
              {state.history.slice(0, 20).map((item) => (
                <li key={item.id}>
                  <Button
                    variant="secondary"
                    isDisabled={disabled || working}
                    onPress={() => void controller?.load(item.id)}
                  >
                    {item.create.title || t('untitled')} ·{' '}
                    {new Date(item.createdAt).toLocaleString()} ·{' '}
                    {duration(item.durationMs)}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </Screen>
  )
}

export function AudioRecording() {
  const { user, isLoggedIn } = useUser()
  const { data } = useConfig()
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user) return <></>
  return (
    <Recorder
      key={user.id}
      viewerId={user.id}
      available={!!data?.meeting_records?.capture_audio_enabled}
    />
  )
}
