import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { Checkbox } from '@/primitives/Checkbox'
import { css } from '@/styled-system/css'
import type {
  ApiCaptureSession,
  ApiMeetingOriginalSegment,
  CaptureAudioRetention,
} from '../api/ApiCaptureSession'
import { formatDateTime } from '../recordDateTime'
import { isAudioRetention } from '../capture/retention'
import { useCorrectOriginalSegment } from '../api/fetchMeetingRecord'
import { RecordSummaryPanel } from './RecordSummaryPanel'
import { OriginalSearch } from './OriginalSearch'
import { LiveCaptureTranscript } from './LiveCaptureTranscript'
import { TranscriptSegment } from './TranscriptSegment'
import {
  useTranscriptDraftScope,
  useTranscriptEditing,
} from '../hooks/useTranscriptDraft'
import {
  activeRowId,
  transcriptWindowTarget,
  useTranscriptFollow,
  usePlaybackResume,
  type TranscriptPlaybackFollow,
  type PlaybackFollow,
  type TimedRow,
} from '../transcriptSync'

type Job = {
  id: string
  generation: number
  status: 'queued' | 'running' | 'succeeded' | 'incomplete' | 'canceled'
  input_count: number
  acknowledged_inputs: number
  final_count: number
  error_code?: string
  mode?: 'live' | 'sealed'
  input_closed?: boolean
}
type State = {
  audio_retention?: CaptureAudioRetention
  available: boolean
  live_available?: boolean
  summary_available?: boolean
  staged_summary_available?: boolean
  active_job_id: string | null
  results: Job[]
}
type Intent = {
  key: string
  expected_job_id: string | null
  allow_incomplete: boolean
  live?: boolean
}
const active = (job?: Job) =>
  !!job && ['queued', 'running'].includes(job.status)
const noSpeech = (job?: Job) =>
  job?.status === 'incomplete' &&
  job.error_code === 'no_speech_detected' &&
  job.final_count === 0
const style = css({
  marginTop: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})

/** Mount with a viewer/capture key so pending intent and private queries never cross accounts. */
export function CaptureTranscriptionPanel({
  viewerId,
  capture,
  onSource,
  includeSummary = true,
  compactControls = false,
  positionMs,
  activeId,
  follow,
}: {
  viewerId: string
  capture: ApiCaptureSession
  onSource?: (milliseconds: number) => void
  includeSummary?: boolean
  compactControls?: boolean
  /** Playback position in the source clock, so the text can follow audio. */
  positionMs?: number
  activeId?: string | null
  follow?: TranscriptPlaybackFollow
}) {
  const { t } = useTranslation('capture')
  const path = `capture-sessions/${capture.id}/transcription/`
  const storageKey = `capture-asr:${viewerId}:${capture.id}`
  const [intent, setIntent] = useState<Intent>()
  const [ready, setReady] = useState(false)
  const [allowIncomplete, setAllowIncomplete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSummary, setShowSummary] = useState(false)
  const [showControls, setShowControls] = useState(false)
  const [message, setMessage] = useState('')
  const busy = useRef(false)
  const abort = useRef<AbortController>()
  useEffect(() => {
    abort.current = new AbortController()
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw) {
        const value: Intent = JSON.parse(raw)
        if (
          typeof value.key !== 'string' ||
          typeof value.allow_incomplete !== 'boolean' ||
          (value.live !== undefined && typeof value.live !== 'boolean') ||
          (value.expected_job_id !== null &&
            typeof value.expected_job_id !== 'string')
        )
          throw new Error()
        setIntent(value)
      }
      setReady(true)
    } catch {
      setMessage('asr.recoveryError')
    }
    return () => abort.current?.abort()
  }, [storageKey])
  const state = useQuery({
    queryKey: ['capture-asr', viewerId, path],
    queryFn: ({ signal }) =>
      fetchApi<State>(path, { signal, cache: 'no-store' }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) => (query.state.error ? false : 5000),
  })
  const latest = state.data?.results[0]
  const retention = state.data?.audio_retention
  const textMode = capture.audio_retention?.mode === 'text'
  const retryOpen = () =>
    !textMode ||
    (isAudioRetention(retention) &&
      retention.mode === 'text' &&
      !retention.expired &&
      retention.cleanup_status === 'not_started' &&
      Date.now() < Date.parse(retention.retry_until!))
  const openCapture = capture.status !== 'stopped'
  const canStartLive =
    ['recording', 'paused', 'interrupted'].includes(capture.status) &&
    !!state.data?.live_available
  const canCreate =
    (openCapture ? canStartLive : !!state.data?.available) && retryOpen()
  const clearIntent = () => {
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      setReady(false)
      setMessage('asr.recoveryError')
      return
    }
    setIntent(undefined)
  }
  const create = async () => {
    if (
      busy.current ||
      !ready ||
      (!intent && (!canCreate || !retryOpen() || active(latest)))
    )
      return
    busy.current = true
    setSaving(true)
    setMessage('')
    try {
      const request = intent ?? {
        key: crypto.randomUUID(),
        expected_job_id: latest?.id ?? null,
        allow_incomplete: allowIncomplete,
        ...(openCapture ? { live: true } : {}),
      }
      // Persist before any billable intent; ambiguous responses reuse this exact key.
      sessionStorage.setItem(storageKey, JSON.stringify(request))
      setIntent(request)
      await fetchApi<{ job: Job }>(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': request.key },
        meetingCommand: { key: request.key, scope: { capture_id: capture.id } },
        body: JSON.stringify({
          expected_job_id: request.expected_job_id,
          allow_incomplete: request.allow_incomplete,
          ...(request.live !== undefined ? { live: request.live } : {}),
        }),
        signal: AbortSignal.any([
          abort.current!.signal,
          AbortSignal.timeout(20000),
        ]),
      })
      if (abort.current?.signal.aborted) return
      clearIntent()
      await state.refetch()
    } catch (error) {
      if (abort.current?.signal.aborted) return
      if (
        error instanceof ApiError &&
        [400, 409, 422].includes(error.statusCode)
      ) {
        clearIntent()
        setMessage(error.statusCode === 409 ? 'asr.conflict' : 'asr.denied')
        await state.refetch()
      } else setMessage('asr.uncertain')
    } finally {
      busy.current = false
      if (!abort.current?.signal.aborted) setSaving(false)
    }
  }
  const cancel = async () => {
    if (busy.current || !latest) return
    busy.current = true
    setSaving(true)
    setMessage('')
    try {
      await fetchApi(`${path}${latest.id}/cancel/`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.any([
          abort.current!.signal,
          AbortSignal.timeout(20000),
        ]),
      })
      if (!abort.current?.signal.aborted) await state.refetch()
    } catch {
      if (!abort.current?.signal.aborted) setMessage('asr.cancelUnknown')
    } finally {
      busy.current = false
      if (!abort.current?.signal.aborted) setSaving(false)
    }
  }
  if (state.isError)
    return (
      <section className={style}>
        <p role="alert">{t('asr.denied')}</p>
        <Button variant="secondary" onPress={() => void state.refetch()}>
          {t('asr.refresh')}
        </Button>
      </section>
    )
  if (!state.data)
    return <StateHint state="loading">{t('asr.loading')}</StateHint>
  if (
    !(openCapture ? state.data.live_available : state.data.available) &&
    !state.data.results.length &&
    !intent &&
    !textMode
  )
    return null
  const foldControls =
    compactControls &&
    !!state.data.active_job_id &&
    !active(latest) &&
    !noSpeech(latest) &&
    !intent &&
    !message &&
    !textMode
  return (
    <section className={style} aria-label={t('asr.title')}>
      {foldControls && (
        <Button
          variant="tertiary"
          aria-expanded={showControls}
          onPress={() => setShowControls(!showControls)}
        >
          {t('asr.controls')}
        </Button>
      )}
      <div hidden={foldControls && !showControls}>
        <h2>{t('asr.title')}</h2>
        {textMode && (
          <div role="status">
            {isAudioRetention(retention) ? (
              <>
                <p>{t(`retention.${retention.cleanup_status}`)}</p>
                <p>
                  {t('retention.deadline', {
                    time: formatDateTime(retention.temporary_until),
                  })}
                </p>
                <p>
                  {t('retention.retryUntil', {
                    time: formatDateTime(retention.retry_until),
                  })}
                </p>
                {!retryOpen() && <p>{t('retention.retryClosed')}</p>}
              </>
            ) : (
              <p>{t('retention.unavailable')}</p>
            )}
          </div>
        )}
        <p>{t(openCapture ? 'asr.liveScope' : 'asr.scope')}</p>
        {latest && (
          <p role="status">
            {t('asr.version', { number: latest.generation })} ·{' '}
            {t(
              noSpeech(latest) ? 'asr.noSpeech' : `asr.status.${latest.status}`
            )}
            {active(latest) &&
              ` · ${t('asr.progress', { done: latest.acknowledged_inputs, total: latest.input_count })}`}
          </p>
        )}
        {noSpeech(latest) && <p>{t('asr.noSpeechHint')}</p>}
        {capture.media_status === 'incomplete' && !active(latest) && (
          <Checkbox
            isSelected={allowIncomplete}
            isDisabled={saving || !!intent}
            onChange={setAllowIncomplete}
          >
            {t('asr.acceptIncomplete')}
          </Checkbox>
        )}
        {message && <p role="alert">{t(message)}</p>}
        <div
          className={css({ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' })}
        >
          {intent ? (
            <Button
              variant="secondary"
              isDisabled={saving}
              onPress={() => void create()}
            >
              {t('asr.recover')}
            </Button>
          ) : (
            <Button
              variant="primary"
              isDisabled={
                !ready ||
                saving ||
                !canCreate ||
                active(latest) ||
                capture.media_status === 'empty' ||
                (capture.media_status === 'incomplete' && !allowIncomplete)
              }
              onPress={() => void create()}
            >
              {t(
                openCapture
                  ? latest
                    ? 'asr.liveRetry'
                    : 'asr.liveStart'
                  : latest
                    ? 'asr.retry'
                    : 'asr.start'
              )}
            </Button>
          )}
          {active(latest) && (
            <Button
              variant="secondary"
              isDisabled={saving}
              onPress={() => void cancel()}
            >
              {t('asr.cancel')}
            </Button>
          )}
          <Button
            variant="secondary"
            isDisabled={saving}
            onPress={() => void state.refetch()}
          >
            {t('asr.refresh')}
          </Button>
        </div>
      </div>
      {latest?.mode === 'live' && latest.id !== state.data.active_job_id && (
        <LiveCaptureTranscript
          key={`${viewerId}:${latest.id}`}
          viewerId={viewerId}
          captureId={capture.id}
          jobId={latest.id}
          lastSequence={latest.final_count}
        />
      )}
      {!openCapture && state.data.active_job_id && (
        <Originals
          key={`${viewerId}:${state.data.active_job_id}`}
          viewerId={viewerId}
          capture={capture}
          jobId={state.data.active_job_id}
          onSource={textMode ? undefined : onSource}
          positionMs={positionMs}
          activeId={activeId}
          follow={follow}
        />
      )}
      {!!state.data.results.length && (
        <details>
          <summary>{t('asr.history')}</summary>
          <ul>
            {state.data.results.map((job) => (
              <li key={job.id}>
                {t('asr.version', { number: job.generation })} ·{' '}
                {t(noSpeech(job) ? 'asr.noSpeech' : `asr.status.${job.status}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {includeSummary &&
        (openCapture
          ? state.data.staged_summary_available
          : state.data.summary_available) && (
          <details
            onToggle={(event) => setShowSummary(event.currentTarget.open)}
          >
            <summary>
              {t(openCapture ? 'asr.liveSummary' : 'asr.summary')}
            </summary>
            {showSummary && (
              <>
                {openCapture && <p>{t('asr.liveSummaryHint')}</p>}
                <RecordSummaryPanel
                  recordId={capture.record_id}
                  viewerId={viewerId}
                  onSourceAudio={openCapture || textMode ? undefined : onSource}
                  duringCapture={openCapture}
                  showHeading={false}
                />
              </>
            )}
          </details>
        )}
    </section>
  )
}

function Originals({
  viewerId,
  capture,
  jobId,
  onSource,
  positionMs,
  activeId,
  follow,
}: {
  viewerId: string
  capture: ApiCaptureSession
  jobId: string
  onSource?: (milliseconds: number) => void
  /** Playback position in the source clock; undefined when nothing is playing. */
  positionMs?: number
  activeId?: string | null
  follow?: TranscriptPlaybackFollow
}) {
  const { t } = useTranslation('capture')
  const [cursors, setCursors] = useState<string[]>([''])
  const [search, setSearch] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [anchorMs, setAnchorMs] = useState(0)
  const [following, setFollowing] = useState(true)
  const cursor = cursors.at(-1)!
  const path = `meeting-records/${capture.record_id}/original-segments/?transcription_job_id=${jobId}&cursor=${encodeURIComponent(cursor)}&q=${encodeURIComponent(search)}&at_ms=${search ? 0 : anchorMs}`
  const searchForm = (
    <OriginalSearch
      value={searchDraft}
      onChange={(value) => {
        setSearchDraft(value)
        setFollowing(false)
      }}
      onSearch={(query) => {
        setSearchDraft(query)
        setSearch(query)
        setCursors([''])
      }}
    />
  )
  const query = useQuery({
    queryKey: ['capture-originals', viewerId, path],
    queryFn: ({ signal }) =>
      fetchApi<{
        results: ApiMeetingOriginalSegment[]
        next_cursor: string | null
      }>(path, { signal, cache: 'no-store' }),
    gcTime: 0,
    retry: false,
    staleTime: 0,
  })
  const next = query.data?.next_cursor
  // Computed before the early returns below so hook order cannot change.
  // Rows carry their own window, matching the clock the player reports in.
  const timedRows: TimedRow[] = (query.data?.results ?? []).map((row) => ({
    id: row.id,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
  }))
  const resolvedActiveId =
    positionMs === undefined
      ? (activeId ?? null)
      : activeRowId(timedRows, positionMs)
  const resolvedFollow: Pick<
    PlaybackFollow,
    'suppressed' | 'suppressionEpoch'
  > & { positionMs?: number } = {
    suppressed: () => false,
    suppressionEpoch: 0,
    ...follow,
    positionMs,
  }
  const listRef = useRef<HTMLDivElement>(null)
  /**
   * Correcting is offered from here because this list is the reader's view of the
   * source. A record whose text lives somewhere without a revision model simply
   * gets no handler, and the row renders without an edit control.
   */
  const correction = useCorrectOriginalSegment(viewerId, capture.record_id)
  const drafts = useTranscriptDraftScope()
  const editing = useTranscriptEditing()
  useEffect(() => {
    if (
      query.error instanceof ApiError &&
      [401, 403, 404].includes(query.error.statusCode)
    )
      drafts?.clear()
  }, [query.error, drafts])
  const correct = (segmentId: string, next: string, expectedRevision: number) =>
    correction.mutateAsync({ segmentId, text: next, expectedRevision })
  const revert = (segmentId: string, expectedRevision: number) =>
    correction.mutateAsync({ segmentId, revert: true, expectedRevision })
  /** The visible rows are a subset, so position cannot address them. */
  const filtersActive = search.trim() !== ''
  usePlaybackResume(follow, () => {
    setSearchDraft('')
    setSearch('')
    setAnchorMs(Math.floor(positionMs ?? 0))
    setCursors([''])
    setFollowing(true)
  })
  const pauseFollowing = follow?.pauseFollowing
  useEffect(() => {
    if (!following || filtersActive || editing) pauseFollowing?.()
  }, [following, filtersActive, editing, pauseFollowing])
  useEffect(() => {
    if (
      !following ||
      editing ||
      follow?.enabled === false ||
      filtersActive ||
      positionMs === undefined ||
      follow?.suppressed()
    )
      return
    const target = transcriptWindowTarget(
      timedRows,
      positionMs,
      anchorMs,
      !!next
    )
    if (target !== null) {
      setAnchorMs(target)
      setCursors([''])
    }
  }, [
    following,
    editing,
    filtersActive,
    positionMs,
    follow,
    timedRows,
    anchorMs,
    next,
  ])
  /**
   * The list scrolls the active row once per change. Scrolling is off while a
   * filter is applied: the active row may not be rendered at all, and a partial
   * list would scroll to whatever happened to survive the filter.
   */
  useTranscriptFollow({
    containerRef: listRef,
    containerReady: query.isSuccess,
    activeId: resolvedActiveId,
    // The rows the highlight came from, so playback in a gap can still advance
    // the view instead of stalling until the next utterance begins.
    rows: timedRows,
    follow: resolvedFollow,
    // A filtered or searched list may omit the active row entirely; following it
    // would scroll to whichever row happened to survive the filter.
    enabled:
      query.isSuccess &&
      !filtersActive &&
      !editing &&
      following &&
      follow?.enabled !== false,
  })
  if (query.isError)
    return (
      <div>
        {searchForm}
        <p role="alert">{t('asr.textError')}</p>
        <Button variant="secondary" onPress={() => void query.refetch()}>
          {t('asr.refresh')}
        </Button>
      </div>
    )
  if (!query.data)
    return (
      <div>
        {searchForm}
        <StateHint state="loading">{t('asr.loading')}</StateHint>
      </div>
    )
  return (
    <div
      className={style}
      ref={listRef}
      onFocusCapture={(event) => {
        if (
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement
        )
          setFollowing(false)
      }}
    >
      {searchForm}
      {positionMs !== undefined &&
        (!following ||
          filtersActive ||
          follow?.enabled === false ||
          follow?.suppressed()) && (
          <Button
            variant="tertiary"
            isDisabled={editing}
            className={css({
              position: 'sticky',
              top: 'sm',
              zIndex: 2,
              marginBottom: 'sm',
            })}
            onPress={() => {
              if (editing) return
              setSearchDraft('')
              setSearch('')
              setAnchorMs(Math.floor(positionMs))
              setCursors([''])
              setFollowing(true)
              follow?.resumeFollowing?.()
            }}
          >
            {t('library.backToPlayback', { ns: 'meetings' })}
          </Button>
        )}
      <h3>{t('asr.originals')}</h3>
      <p>{t(onSource ? 'asr.unknownSpeaker' : 'retention.noPlayback')}</p>
      {!query.data.results.length && <p>{t('asr.noText')}</p>}
      {query.data.results.map((row) => (
        <TranscriptSegment
          key={row.id}
          segmentId={row.id}
          playbackAlignment={row.playback_alignment}
          positionMs={positionMs}
          onWordSeek={onSource}
          active={resolvedActiveId === row.id}
          originalText={row.original_text}
          isCorrected={row.is_corrected === true}
          correctionRevision={row.correction_revision}
          onCorrect={
            row.can_correct && row.correction_revision !== undefined
              ? correct
              : undefined
          }
          onRevert={
            row.can_correct && row.correction_revision !== undefined
              ? revert
              : undefined
          }
          correcting={correction.isPending}
          speaker={row.speaker_label || t('asr.unknownSpeaker')}
          time={`${Math.floor(row.start_ms / 60000)}:${String(Math.floor(row.start_ms / 1000) % 60).padStart(2, '0')}`}
          onSeek={onSource ? () => onSource(row.start_ms) : undefined}
          seekLabel={t('asr.source', {
            time: `${Math.floor(row.start_ms / 60000)}:${String(Math.floor(row.start_ms / 1000) % 60).padStart(2, '0')}`,
          })}
          text={row.text}
        />
      ))}
      <div className={css({ display: 'flex', gap: '0.75rem' })}>
        {cursors.length > 1 && (
          <Button
            variant="secondary"
            onPress={() => {
              setFollowing(false)
              setCursors((values) => values.slice(0, -1))
            }}
          >
            {t('previous')}
          </Button>
        )}
        {next && (
          <Button
            variant="secondary"
            onPress={() => {
              setFollowing(false)
              setCursors((values) => [...values, next])
            }}
          >
            {t('next')}
          </Button>
        )}
      </div>
    </div>
  )
}
