import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import type {
  ApiCaptureSession,
  ApiMeetingOriginalSegment,
} from '../api/ApiCaptureSession'
import { RecordSummaryPanel } from './RecordSummaryPanel'

type Job = {
  id: string
  generation: number
  status: 'queued' | 'running' | 'succeeded' | 'incomplete' | 'canceled'
  input_count: number
  acknowledged_inputs: number
  final_count: number
}
type State = {
  available: boolean
  summary_available?: boolean
  active_job_id: string | null
  results: Job[]
}
type Intent = {
  key: string
  expected_job_id: string | null
  allow_incomplete: boolean
}
const active = (job?: Job) =>
  !!job && ['queued', 'running'].includes(job.status)
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
}: {
  viewerId: string
  capture: ApiCaptureSession
  onSource: (milliseconds: number) => void
}) {
  const { t } = useTranslation('capture')
  const path = `capture-sessions/${capture.id}/transcription/`
  const storageKey = `capture-asr:${viewerId}:${capture.id}`
  const [intent, setIntent] = useState<Intent>()
  const [ready, setReady] = useState(false)
  const [allowIncomplete, setAllowIncomplete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSummary, setShowSummary] = useState(false)
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
      (!intent && (!state.data?.available || active(latest)))
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
      }
      // Persist before any billable intent; ambiguous responses reuse this exact key.
      sessionStorage.setItem(storageKey, JSON.stringify(request))
      setIntent(request)
      await fetchApi<{ job: Job }>(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': request.key },
        body: JSON.stringify({
          expected_job_id: request.expected_job_id,
          allow_incomplete: request.allow_incomplete,
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
        error.statusCode < 500 &&
        error.statusCode !== 429
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
  if (!state.data) return <p role="status">{t('asr.loading')}</p>
  if (!state.data.available && !state.data.results.length && !intent)
    return null
  return (
    <section className={style} aria-label={t('asr.title')}>
      <h2>{t('asr.title')}</h2>
      <p>{t('asr.scope')}</p>
      {latest && (
        <p role="status">
          {t('asr.version', { number: latest.generation })} ·{' '}
          {t(`asr.status.${latest.status}`)}
          {active(latest) &&
            ` · ${t('asr.progress', { done: latest.acknowledged_inputs, total: latest.input_count })}`}
        </p>
      )}
      {capture.media_status === 'incomplete' && !active(latest) && (
        <label>
          <input
            type="checkbox"
            checked={allowIncomplete}
            disabled={saving || !!intent}
            onChange={(event) => setAllowIncomplete(event.target.checked)}
          />{' '}
          {t('asr.acceptIncomplete')}
        </label>
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
              !state.data.available ||
              active(latest) ||
              capture.media_status === 'empty' ||
              (capture.media_status === 'incomplete' && !allowIncomplete)
            }
            onPress={() => void create()}
          >
            {t(latest ? 'asr.retry' : 'asr.start')}
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
      {state.data.active_job_id && (
        <Originals
          key={`${viewerId}:${state.data.active_job_id}`}
          viewerId={viewerId}
          capture={capture}
          jobId={state.data.active_job_id}
          onSource={onSource}
        />
      )}
      {!!state.data.results.length && (
        <details>
          <summary>{t('asr.history')}</summary>
          <ul>
            {state.data.results.map((job) => (
              <li key={job.id}>
                {t('asr.version', { number: job.generation })} ·{' '}
                {t(`asr.status.${job.status}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.data.summary_available && (
        <details onToggle={(event) => setShowSummary(event.currentTarget.open)}>
          <summary>{t('asr.summary')}</summary>
          {showSummary && (
            <RecordSummaryPanel
              recordId={capture.record_id}
              viewerId={viewerId}
              onSourceAudio={onSource}
            />
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
}: {
  viewerId: string
  capture: ApiCaptureSession
  jobId: string
  onSource: (milliseconds: number) => void
}) {
  const { t } = useTranslation('capture')
  const [cursors, setCursors] = useState<string[]>([''])
  const cursor = cursors.at(-1)!
  const path = `meeting-records/${capture.record_id}/original-segments/?transcription_job_id=${jobId}&cursor=${encodeURIComponent(cursor)}`
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
  if (query.isError)
    return (
      <div>
        <p role="alert">{t('asr.textError')}</p>
        <Button variant="secondary" onPress={() => void query.refetch()}>
          {t('asr.refresh')}
        </Button>
      </div>
    )
  if (!query.data) return <p role="status">{t('asr.loading')}</p>
  return (
    <div className={style}>
      <h3>{t('asr.originals')}</h3>
      <p>{t('asr.unknownSpeaker')}</p>
      {!query.data.results.length && <p>{t('asr.noText')}</p>}
      {query.data.results.map((row) => (
        <article key={row.id}>
          <Button variant="tertiary" onPress={() => onSource(row.start_ms)}>
            {t('asr.source', {
              time: `${Math.floor(row.start_ms / 60000)}:${String(Math.floor(row.start_ms / 1000) % 60).padStart(2, '0')}`,
            })}
          </Button>
          <p
            className={css({
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            })}
          >
            {row.text}
          </p>
        </article>
      ))}
      <div className={css({ display: 'flex', gap: '0.75rem' })}>
        {cursors.length > 1 && (
          <Button
            variant="secondary"
            onPress={() => setCursors((values) => values.slice(0, -1))}
          >
            {t('previous')}
          </Button>
        )}
        {next && (
          <Button
            variant="secondary"
            onPress={() => setCursors((values) => [...values, next])}
          >
            {t('next')}
          </Button>
        )}
      </div>
    </div>
  )
}
