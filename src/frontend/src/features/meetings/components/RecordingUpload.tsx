import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

type UploadState = {
  record_id: string
  status: 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed'
  attempt: number
  retryable: boolean
  error_code: string
}

const field = css({
  display: 'block',
  width: '100%',
  padding: '0.5rem',
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '0.375rem',
})

export function RecordingUpload({ viewerId }: { viewerId: string }) {
  const { t } = useTranslation('meetings')
  const [, navigate] = useLocation()
  const [file, setFile] = useState<File | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [context, setContext] = useState('')
  const [hotwords, setHotwords] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const capabilities = useQuery({
    queryKey: ['recording-upload-capabilities', viewerId],
    queryFn: ({ signal }) =>
      fetchApi<{ available: boolean; max_bytes: number; extensions: string[] }>(
        'recording-uploads/',
        { signal, cache: 'no-store' }
      ),
    retry: false,
    gcTime: 0,
  })
  if (!capabilities.data?.available) return null
  const config = capabilities.data
  return (
    <details className={css({ marginBottom: '1.5rem' })}>
      <summary className={css({ cursor: 'pointer', fontWeight: 600 })}>
        {t('upload.title')}
      </summary>
      <form
        className={css({
          display: 'grid',
          gap: '0.75rem',
          paddingTop: '1rem',
          maxWidth: '40rem',
        })}
        onSubmit={async (event) => {
          event.preventDefault()
          if (!file || busy) return
          setError(false)
          if (
            !file.size ||
            file.size > config.max_bytes ||
            !config.extensions.includes(
              file.name.split('.').pop()!.toLowerCase()
            )
          ) {
            setError(true)
            return
          }
          setBusy(true)
          const body = new FormData()
          body.set('key', key)
          body.set('audio', file)
          body.set('context', context)
          body.set('hotwords', hotwords)
          try {
            const result = await fetchApi<UploadState>('recording-uploads/', {
              method: 'POST',
              body,
            })
            navigate(`/meeting/records/${result.record_id}?tab=text`)
          } catch {
            setError(true)
          } finally {
            setBusy(false)
          }
        }}
      >
        <p>
          {t('upload.hint', {
            size: Math.floor(config.max_bytes / 1024 / 1024),
          })}
        </p>
        <label>
          {t('upload.file')}
          <input
            className={field}
            type="file"
            required
            disabled={busy}
            accept={config.extensions
              .map((extension) => `.${extension}`)
              .join(',')}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null)
              setKey(crypto.randomUUID())
            }}
          />
        </label>
        <label>
          {t('upload.context')}
          <textarea
            className={field}
            maxLength={400}
            disabled={busy}
            value={context}
            onChange={(event) => {
              setContext(event.target.value)
              setKey(crypto.randomUUID())
            }}
          />
        </label>
        <label>
          {t('upload.hotwords')}
          <textarea
            className={field}
            maxLength={4000}
            disabled={busy}
            value={hotwords}
            onChange={(event) => {
              setHotwords(event.target.value)
              setKey(crypto.randomUUID())
            }}
          />
        </label>
        <p>{t('upload.consent')}</p>
        <Button type="submit" isDisabled={!file || busy}>
          {t(busy ? 'upload.uploading' : 'upload.submit')}
        </Button>
        {busy && <p role="status">{t('upload.keepOpen')}</p>}
        {error && <p role="alert">{t('upload.error')}</p>}
      </form>
    </details>
  )
}

export function UploadedRecordingStatus({
  recordId,
  viewerId,
}: {
  recordId: string
  viewerId: string
}) {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const query = useQuery({
    queryKey: ['recording-upload-state', viewerId, recordId],
    queryFn: async ({ signal }) => {
      const state = await fetchApi<UploadState>(
        `recording-uploads/${recordId}/`,
        { signal, cache: 'no-store' }
      )
      if (state.status === 'succeeded')
        void client.invalidateQueries({
          queryKey: ['meeting-records', viewerId, 'detail', recordId],
        })
      return state
    },
    retry: false,
    gcTime: 0,
    refetchInterval: (q) =>
      q.state.error ||
      ['succeeded', 'failed'].includes(q.state.data?.status ?? '')
        ? false
        : 5000,
  })
  if (query.isError) return <p role="alert">{t('upload.stateError')}</p>
  if (!query.data) return <p role="status">{t('loading')}</p>
  const state = query.data
  return (
    <section className={css({ marginBottom: '1rem' })}>
      <p role="status">{t(`upload.status.${state.status}`)}</p>
      {state.retryable && (
        <>
          <p>
            {t(
              state.error_code === 'submission_unknown'
                ? 'upload.unknown'
                : 'upload.failedHint'
            )}
          </p>
          <Button
            isDisabled={busy}
            onPress={async () => {
              setBusy(true)
              setError(false)
              try {
                await fetchApi(`recording-uploads/${recordId}/`, {
                  method: 'POST',
                  body: JSON.stringify({ attempt: state.attempt }),
                })
                await query.refetch()
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('upload.retry')}
          </Button>
        </>
      )}
      {error && <p role="alert">{t('upload.error')}</p>}
    </section>
  )
}
