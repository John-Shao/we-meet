import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { Button, Dialog } from '@/primitives'
import { RiUpload2Line } from '@remixicon/react'
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

export function RecordingUpload({
  viewerId,
  tile = false,
  onRecord,
}: {
  viewerId: string
  tile?: boolean
  onRecord?: (id: string) => void
}) {
  const { t } = useTranslation('meetings')
  const [, navigate] = useLocation()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [context, setContext] = useState('')
  const [hotwords, setHotwords] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
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
  const extension = file?.name.split('.').pop()?.toLowerCase() ?? ''
  const valid =
    !!file &&
    file.size > 0 &&
    file.size <= config.max_bytes &&
    config.extensions.includes(extension)
  const video = [
    'avi',
    'flv',
    'mkv',
    'mov',
    'mp4',
    'mpeg',
    'webm',
    'wmv',
  ].includes(extension)
  return (
    <>
      <input
        ref={input}
        hidden
        type="file"
        aria-label={t('upload.file')}
        disabled={busy}
        accept={config.extensions.map((ext) => `.${ext}`).join(',')}
        onChange={(event) => {
          const selected = event.target.files?.[0]
          if (!selected) return
          setFile(selected)
          setKey(crypto.randomUUID())
          setError(false)
          setOpen(true)
          event.target.value = ''
        }}
      />
      {tile ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className={css({
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1rem 2rem',
            color: 'primary.700',
            borderRadius: '0.75rem',
            backgroundColor: 'primary.100',
            cursor: 'pointer',
            _focusVisible: {
              outline: '2px solid token(colors.primary.500)',
              outlineOffset: '2px',
            },
          })}
        >
          <RiUpload2Line size={32} aria-hidden />
          {t('upload.open')}
        </button>
      ) : (
        <Button
          variant="secondary"
          icon={<RiUpload2Line size={18} aria-hidden />}
          onPress={() => input.current?.click()}
        >
          {t('upload.open')}
        </Button>
      )}
      <Dialog
        isOpen={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
        title={t('upload.title')}
      >
        <form
          className={css({
            display: 'grid',
            gap: '0.75rem',
            maxHeight: '70dvh',
            overflowY: 'auto',
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
              setOpen(false)
              if (onRecord) onRecord(result.record_id)
              else navigate(`/meeting/records/${result.record_id}?tab=text`)
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
          <p className={css({ overflowWrap: 'anywhere', fontWeight: 600 })}>
            {file?.name}
          </p>
          <p>
            {t(video ? 'upload.video' : 'upload.audio')} ·{' '}
            {file
              ? (file.size / 1024 / 1024).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })
              : 0}{' '}
            MB
          </p>
          {video && <p>{t('upload.videoHint')}</p>}
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => input.current?.click()}
          >
            {t('upload.choose')}
          </Button>
          {!valid && <p role="alert">{t('upload.error')}</p>}
          <details>
            <summary
              className={css({
                cursor: 'pointer',
                padding: '0.5rem 0',
                fontSize: '0.875rem',
              })}
            >
              {t('upload.advanced')}
            </summary>
            <div
              className={css({
                display: 'grid',
                gap: '0.75rem',
                paddingTop: '0.5rem',
              })}
            >
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
            </div>
          </details>
          <p className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}>
            {t('upload.consent')}
          </p>
          <Button type="submit" isDisabled={!valid || busy}>
            {t(busy ? 'upload.uploading' : 'upload.submit')}
          </Button>
          {busy && <p role="status">{t('upload.keepOpen')}</p>}
          {error && valid && <p role="alert">{t('upload.error')}</p>}
        </form>
      </Dialog>
    </>
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
  if (state.status === 'succeeded') return null
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
