import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Redirect } from 'wouter'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Button, Input } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { StateHint } from '@/components/StateHint'
import { css, cx } from '@/styled-system/css'
import { MeetingDetailHeader } from '../components/MeetingDetailHeader'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { formatDateTime } from '../recordDateTime'
import {
  pageFixedTop,
  pageLead,
  pageShell,
  scrollRegion,
  sectionTitle,
} from '../components/libraryStyles'
import { CaptureJournal, type LocalAudioChunk } from '../capture/journal'
import {
  RecordingController,
  type CaptureViewState,
} from '../capture/controller'
import { withCaptureLock } from '../capture/microphone'
import { captureTransport, textAudioAvailable } from '../capture/transport'
import { textAudioExpired } from '../capture/retention'
import { CaptureTranscriptionPanel } from '../components/CaptureTranscriptionPanel'
import { CaptureTranslationPanel } from '../components/CaptureTranslationPanel'

const duration = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 页壳与滚动区:与列表页同一套(铺满 + 唯一滚动区)。 */
const canvasShell = pageShell('canvas')
const contentScroll = cx(scrollRegion, css({ paddingTop: 'lg' }))

/** 表单卡:与会议模块其它卡片同一档描边 / 圆角 / 底色。 */
const formCard = css({
  padding: 'lg',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
  display: 'flex',
  flexDirection: 'column',
  gap: 'lg',
})

/** 字段标签与控件。 */
const fieldLabel = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  textStyle: 'labelLarge',
  color: 'text.secondary',
})
const fieldControl = css({ marginTop: 'xxs' })

/** 说明性文字(离开页面的提示等)。 */
const hintCls = cx(pageLead, css({ marginBottom: 'lg' }))

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
  const [textAvailable, setTextAvailable] = useState(false)
  const [textOnly, setTextOnly] = useState(false)
  const [localChunks, setLocalChunks] = useState<LocalAudioChunk[]>([])
  const [localPage, setLocalPage] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setTextAvailable(false)
    if (available)
      void textAudioAvailable(abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) setTextAvailable(value)
        })
        .catch(() => undefined)
    return () => abort.abort()
  }, [viewerId, available])

  useEffect(() => {
    if (!controller) return
    const timer = window.setInterval(
      () => void controller.checkRetention(),
      1000
    )
    return () => window.clearInterval(timer)
  }, [controller])

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
  const recoverable = state.history
    .map((item) => (item.id === local?.id ? local : item))
    .filter((item) => !item.sealed || item.pendingBytes > 0)
  const canResume =
    working &&
    state.mode !== 'recording' &&
    !local.sealIntent &&
    local.remote?.status !== 'stopping' &&
    local.remote?.status !== 'stopped' &&
    !textAudioExpired(local)
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
    <MeetingModuleShell>
      <main className={canvasShell}>
        {/* 层级标题钉住；录音表单与各面板在滚动区里。 */}
        <div className={pageFixedTop}>
          <MeetingDetailHeader
            viewerId={viewerId}
            listHref="/meeting/recording"
            listLabel={t('library.record', { ns: 'meetings' })}
            title={working ? local.create.title || t('untitled') : t('title')}
          />
        </div>
        <div className={contentScroll}>
          <p className={pageLead}>
            {t(
              textOnly || (working && local.create.retention_mode === 'text')
                ? 'textScope'
                : 'scope'
            )}
          </p>
          <p className={hintCls}>
            {t(
              textOnly || (working && local.create.retention_mode === 'text')
                ? 'textLeaveHint'
                : 'leaveHint'
            )}
          </p>
          {unavailable && (
            <StateHint state="error">{t('unavailable')}</StateHint>
          )}
          {!available && <StateHint state="empty">{t('disabled')}</StateHint>}
          <section className={formCard}>
            {working ? (
              <h2 className={sectionTitle}>
                {local.create.title || t('untitled')}
              </h2>
            ) : (
              <label className={fieldLabel}>
                {t('name')}
                <Input
                  aria-label={t('name')}
                  maxLength={500}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className={fieldControl}
                />
              </label>
            )}
            {!working && textAvailable && (
              <div>
                <Checkbox
                  isSelected={textOnly}
                  isDisabled={disabled}
                  onChange={setTextOnly}
                >
                  {t('textOnly')}
                </Checkbox>
                {textOnly && <p role="note">{t('textOnlyConsent')}</p>}
              </div>
            )}
            {working && local?.create.retention_mode === 'text' && (
              <p role="note">{t('textOnlyConsent')}</p>
            )}
            <p role="status" aria-live="polite">
              {t(
                state.mode === 'saved' &&
                  local?.create.retention_mode === 'text'
                  ? 'textSaved'
                  : `state.${state.mode}`
              )}
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
                gap: 'md',
              })}
            >
              {!working && (
                <Button
                  variant="primary"
                  isDisabled={
                    disabled || !available || (textOnly && !textAvailable)
                  }
                  onPress={() =>
                    void controller?.start(title, textOnly ? 'text' : 'media')
                  }
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
          {working && local?.remote && controller && (
            <CaptureTranslationPanel
              key={`translation:${viewerId}:${local.remote.id}:${local.remote.revision}`}
              source={{
                viewerId,
                captureId: local.remote.id,
                recordId: local.remote.record_id,
                deviceId: local.create.device_id,
                leaseKey: local.create.lease_key,
              }}
              revision={local.remote.revision}
              controller={controller}
            />
          )}
          {working && local?.remote && (
            <CaptureTranscriptionPanel
              key={`asr:${viewerId}:${local.remote.id}`}
              viewerId={viewerId}
              capture={local.remote}
              includeSummary={false}
            />
          )}
          {local?.sealed && local.remote && (
            <section
              className={css({
                marginTop: 'xl',
                display: 'flex',
                flexDirection: 'column',
                gap: 'md',
              })}
            >
              <h2 className={sectionTitle}>
                {local.create.title || t('untitled')}
              </h2>
              <p>{t('savedDestination')}</p>
              <div
                className={css({
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 'lg',
                  color: 'text.link',
                })}
              >
                <Link href={`/meeting/records/${local.remote.record_id}`}>
                  {t('openRecord')}
                </Link>
                <Link
                  href={`/meeting/records/${local.remote.record_id}?tab=summary`}
                >
                  {t('openSummary')}
                </Link>
              </div>
            </section>
          )}
          {!!local?.pendingBytes && local.create.retention_mode === 'media' && (
            <section className={css({ marginTop: 'xl' })}>
              <h2 className={sectionTitle}>{t('localAudio')}</h2>
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
                      <Button
                        variant="secondary"
                        onPress={() => download(chunk)}
                      >
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
          {!!recoverable.length && (
            <section className={css({ marginTop: 'xl' })}>
              <h2 className={sectionTitle}>{t('recoverable')}</h2>
              <p>{t('recoverableHint')}</p>
              <ul>
                {recoverable.map((item) => (
                  <li key={item.id}>
                    <Button
                      variant="secondary"
                      isDisabled={disabled || working}
                      onPress={() => void controller?.load(item.id)}
                    >
                      {item.create.title || t('untitled')} ·{' '}
                      {formatDateTime(item.createdAt)} ·{' '}
                      {duration(item.durationMs)}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </MeetingModuleShell>
  )
}

export function AudioRecording() {
  const { user, isLoggedIn } = useUser()
  const { data } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  // 用户资料还没到时返回空片段 = 白屏。另外三个栏目页这一档都是
  // `StateHint state="loading"`,这里跟它们对齐。
  if (!user) return <StateHint state="loading">{t('loading')}</StateHint>
  return (
    <Recorder
      key={user.id}
      viewerId={user.id}
      available={!!data?.meeting_records?.capture_audio_enabled}
    />
  )
}
