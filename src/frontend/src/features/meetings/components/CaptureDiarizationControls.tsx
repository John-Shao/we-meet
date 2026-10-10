import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { Button } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { css } from '@/styled-system/css'
import { sameAuthSession } from '@/features/auth/utils/tokenStorage'
import {
  DiarizationClient,
  clearDiarizationIntents,
  type DiarizationIntent,
} from '../capture/diarization'

export function CaptureDiarizationControls({
  viewerId,
  captureId,
  onPublished,
  editing = false,
}: {
  viewerId: string
  captureId: string
  onPublished: () => void
  editing?: boolean
}) {
  const [client] = useState(() => new DiarizationClient(viewerId, captureId))
  const { t } = useTranslation('capture')
  const cache = useQueryClient()
  const [valid, setValid] = useState(true)
  const [accepted, setAccepted] = useState(false)
  const [intent, setIntent] = useState<DiarizationIntent>()
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const lifetime = useRef<AbortController>()
  const busy = useRef(false)
  const callback = useRef(onPublished)
  callback.current = onPublished
  const queryKey = [
    'capture-diarization',
    viewerId,
    captureId,
    client.auth.session,
  ]
  const live = useCallback(
    () => !lifetime.current?.signal.aborted && sameAuthSession(client.auth),
    [client]
  )
  useEffect(() => {
    lifetime.current = new AbortController()
    try {
      setIntent(client.intent())
      setReady(true)
    } catch {
      setMessage('diarization.recoveryError')
    }
    const check = () => {
      if (sameAuthSession(client.auth)) return
      lifetime.current?.abort()
      setValid(false)
      setIntent(undefined)
      try {
        clearDiarizationIntents()
      } catch {
        /* Account fence remains closed. */
      }
      cache.removeQueries({
        queryKey: ['capture-diarization', viewerId, captureId],
      })
    }
    const timer = setInterval(check, 250)
    window.addEventListener('storage', check)
    return () => {
      lifetime.current?.abort()
      clearInterval(timer)
      window.removeEventListener('storage', check)
    }
  }, [client, cache, viewerId, captureId])
  const state = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.state(signal),
    enabled: valid,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) => (q.state.error ? false : 5000),
  })
  const data = state.isError ? undefined : state.data
  const published = useRef<string | null | undefined>()
  useEffect(() => {
    const next = data?.active_job_id
    if (next !== undefined && next !== published.current && live()) {
      published.current = next
      void cache.invalidateQueries({ queryKey: ['meeting-records', viewerId] })
      void cache.invalidateQueries({
        queryKey: ['record-library-capture', viewerId, captureId],
      })
      callback.current()
    }
  }, [data?.active_job_id, live, cache, viewerId, captureId])
  useEffect(() => {
    setAccepted(false)
  }, [data?.record_revision, data?.source_transcription_id])
  const create = async () => {
    if (
      busy.current ||
      !ready ||
      editing ||
      state.isError ||
      !live() ||
      (!intent && (!data?.can_start || !accepted))
    )
      return
    busy.current = true
    setSaving(true)
    setMessage('')
    const request = intent ?? {
      key: crypto.randomUUID(),
      expected_revision: data!.record_revision,
    }
    let persisted = false
    try {
      client.remember(request)
      persisted = true
      setIntent(request)
      await client.submit(request, lifetime.current!.signal)
      if (!live()) return
      setIntent(undefined)
      setAccepted(false)
      await state.refetch()
    } catch (error) {
      if (!live()) return
      if (!persisted) {
        setReady(false)
        setMessage('diarization.recoveryError')
        return
      }
      if (
        error instanceof ApiError &&
        [400, 403, 404, 409, 422, 503].includes(error.statusCode)
      ) {
        try {
          client.acknowledge(request.key)
        } catch {
          setReady(false)
          setMessage('diarization.recoveryError')
          return
        }
        setIntent(undefined)
        setAccepted(false)
        setMessage(
          error.statusCode === 409
            ? 'diarization.conflict'
            : 'diarization.denied'
        )
        await state.refetch()
      } else setMessage('diarization.uncertain')
    } finally {
      busy.current = false
      if (live()) setSaving(false)
    }
  }
  const latest = data?.results[0]
  const pending = latest && ['queued', 'running'].includes(latest.status)
  const cancel = async () => {
    if (busy.current || !live() || !latest || !data) return
    busy.current = true
    setSaving(true)
    setMessage('')
    try {
      await client.cancel(
        latest,
        data.record_revision,
        lifetime.current!.signal
      )
      if (live()) await state.refetch()
    } catch {
      if (live()) setMessage('diarization.cancelUnknown')
    } finally {
      busy.current = false
      if (live()) setSaving(false)
    }
  }
  if (!valid) return null
  return (
    <section
      aria-label={t('diarization.title')}
      className={css({
        marginTop: 'lg',
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
        alignItems: 'stretch',
      })}
    >
      <h3>{t('diarization.title')}</h3>
      <p>{t('diarization.hint')}</p>
      {editing && <p role="note">{t('diarization.editing')}</p>}
      {latest && (
        <p role="status">
          {t('diarization.version', { number: latest.generation })} ·{' '}
          {t(`diarization.status.${latest.status}`)}
        </p>
      )}
      {(message || state.isError) && (
        <p role="alert">{t(message || 'diarization.denied')}</p>
      )}
      {!intent && (
        <Checkbox
          isSelected={accepted}
          isDisabled={saving || editing || !data?.can_start}
          onChange={setAccepted}
        >
          {t('diarization.accept')}
        </Checkbox>
      )}
      <div className={css({ display: 'flex', flexWrap: 'wrap', gap: 'sm' })}>
        <Button
          isDisabled={
            saving ||
            state.isError ||
            editing ||
            !ready ||
            (!intent && (!data?.can_start || !accepted))
          }
          onPress={() => void create()}
        >
          {t(
            intent
              ? 'diarization.recover'
              : latest
                ? 'diarization.retry'
                : 'diarization.start'
          )}
        </Button>
        {pending && (
          <Button
            variant="secondary"
            isDisabled={saving}
            onPress={() => void cancel()}
          >
            {t('diarization.cancel')}
          </Button>
        )}
        <Button
          variant="secondary"
          isDisabled={saving}
          onPress={() => void state.refetch()}
        >
          {t('diarization.refresh')}
        </Button>
      </div>
      {!!data?.results.length && (
        <details>
          <summary>{t('diarization.history')}</summary>
          <ul>
            {data.results.map((job) => (
              <li key={job.id}>
                {t('diarization.version', { number: job.generation })} ·{' '}
                {t(`diarization.status.${job.status}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
