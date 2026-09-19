import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { Button, Dialog, TextArea } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { RiDownload2Line } from '@remixicon/react'
import { css, cx } from '@/styled-system/css'
import { rowMeta } from './libraryStyles'

type UploadState = {
  record_id: string
  status: 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed'
  attempt: number
  retryable: boolean
  error_code: string
}

/** What the server can accept, and by which of the two paths. */
type UploadCapabilities = {
  available: boolean
  /** The multipart branch's hard ceiling. */
  max_bytes: number
  extensions: string[]
  /** True once the server offers presigned direct uploads. */
  direct_upload_available?: boolean
  /** The direct branch's ceiling, 0 when direct uploads are off. */
  direct_max_bytes?: number
}

type DirectUploadTicket = {
  upload_url: string
  storage_name: string
  headers: Record<string, string>
}

const DIRECT = 'recording-uploads/upload-url/'
const COMPLETE = 'recording-uploads/upload-complete/'

/**
 * Import one recording, by whichever path the server offers.
 *
 * A presigned direct upload is the only way past the multipart ceiling: the body
 * goes straight to object storage, so it never passes through the app server's
 * disk. `size` is bound into the signature the server hands out, so the storage
 * service enforces the declared length rather than trusting it.
 *
 * The two steps are not atomic, so a failure after the PUT is recovered by
 * re-POSTing completion with the same declaration — the client keeps
 * `storage_name` for exactly that. Re-running the whole flow instead would
 * upload the bytes again.
 */
async function importRecording(
  file: File,
  key: string,
  options: { context: string; hotwords: string },
  direct: { maxBytes: number } | null,
  ticket: { current: DirectUploadTicket | null }
): Promise<UploadState> {
  const content_type = file.type || 'application/octet-stream'
  if (!direct || file.size > direct.maxBytes) {
    const body = new FormData()
    body.set('key', key)
    body.set('audio', file)
    body.set('context', options.context)
    body.set('hotwords', options.hotwords)
    return fetchApi<UploadState>('recording-uploads/', {
      method: 'POST',
      body,
    })
  }

  ticket.current ??= await fetchApi<DirectUploadTicket>(DIRECT, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      key,
      name: file.name,
      size: file.size,
      content_type,
      ...options,
    }),
  })

  // Straight to storage. The URL carries its own authorization in the query
  // string, so this request deliberately sends no app credentials back to a
  // third-party host. The signature covers Content-Type, so that one header
  // must match what was signed.
  let stored = false
  try {
    const response = await fetch(ticket.current.upload_url, {
      method: 'PUT',
      headers: ticket.current.headers,
      body: file,
    })
    stored = response.ok
  } catch {
    stored = false
  }
  if (!stored) {
    // The ticket is spent or the transfer broke; a retry needs a fresh one.
    ticket.current = null
    throw new Error('direct upload failed')
  }

  return fetchApi<UploadState>(COMPLETE, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      key,
      name: file.name,
      size: file.size,
      content_type,
      storage_name: ticket.current.storage_name,
      ...options,
    }),
  })
}

/** 弹窗里的多行输入:外观与状态由共享 TextArea 基元给出,这里只补间距。 */
const textAreaCls = css({ marginTop: 'xs' })

/** 上传弹窗的字段堆叠。 */
const formCls = css({
  display: 'grid',
  gap: 'md',
  maxHeight: '70dvh',
  overflowY: 'auto',
})

const fileNameCls = css({
  textStyle: 'titleSmall',
  color: 'text.primary',
  overflowWrap: 'anywhere',
})

const advancedSummaryCls = css({
  cursor: 'pointer',
  paddingY: 'sm',
  textStyle: 'labelLarge',
  color: 'text.link',
})

const advancedBodyCls = css({
  display: 'grid',
  gap: 'md',
  paddingTop: 'sm',
})

const consentCls = cx(rowMeta, css({ display: 'block' }))

const fieldLabelCls = css({
  display: 'block',
  textStyle: 'labelMedium',
  color: 'text.secondary',
})

/** 上传进度/重试区块:与详情页内容留出一档间距。 */
const statusSectionCls = css({ marginBottom: 'lg' })

export function RecordingUpload({
  viewerId,
  onRecord,
}: {
  viewerId: string
  onRecord?: (id: string) => void
}) {
  const { t } = useTranslation('meetings')
  const [, navigate] = useLocation()
  const input = useRef<HTMLInputElement>(null)
  // A spent or half-used direct-upload ticket, kept across retries so a second
  // attempt does not re-upload bytes that already landed in storage.
  const ticket = useRef<DirectUploadTicket | null>(null)
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
      fetchApi<UploadCapabilities>('recording-uploads/', {
        signal,
        cache: 'no-store',
      }),
    retry: false,
    gcTime: 0,
  })
  if (!capabilities.data?.available) return null
  const config = capabilities.data
  // When the server offers direct uploads, that path's ceiling is the real one;
  // the multipart ceiling only still applies to the legacy branch.
  const directAllowed =
    config.direct_upload_available === true && (config.direct_max_bytes ?? 0) > 0
  const limit = directAllowed
    ? Math.max(config.max_bytes, config.direct_max_bytes ?? 0)
    : config.max_bytes
  const extension = file?.name.split('.').pop()?.toLowerCase() ?? ''
  const valid =
    !!file &&
    file.size > 0 &&
    file.size <= limit &&
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
          // A ticket belongs to one file's bytes; a different file needs its own.
          ticket.current = null
          setError(false)
          setOpen(true)
          event.target.value = ''
        }}
      />
      {/* 只有一种形态了:与另外三个栏目页页头同款的 action 按钮。
          (原先还有一个大入口块的 `tile` 形态,四个页面统一后没有调用点。)
          图标是**向下**的箭头:这一页的动作是「把外部的音视频收进来」,向下的箭头
          才读得通(向上的 RiUpload2Line 看着像要把东西发出去)。
          变体是 `secondaryText`:页头那一栏参考聊天窗口标题栏,次操作不再描边。 */}
      <Button
        variant="secondaryText"
        size="action"
        icon={<RiDownload2Line size={18} aria-hidden />}
        onPress={() => input.current?.click()}
      >
        {t('upload.open')}
      </Button>
      <Dialog
        isOpen={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
        title={t('upload.title')}
      >
        <form
          className={formCls}
          onSubmit={async (event) => {
            event.preventDefault()
            if (!file || busy) return
            setError(false)
            if (
              !file.size ||
              file.size > limit ||
              !config.extensions.includes(
                file.name.split('.').pop()!.toLowerCase()
              )
            ) {
              setError(true)
              return
            }
            setBusy(true)
            try {
              const result = await importRecording(
                file,
                key,
                { context, hotwords },
                directAllowed ? { maxBytes: limit } : null,
                ticket
              )
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
              size: Math.floor(limit / 1024 / 1024),
            })}
          </p>
          <p className={fileNameCls}>{file?.name}</p>
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
            size="action"
            isDisabled={busy}
            onPress={() => input.current?.click()}
          >
            {t('upload.choose')}
          </Button>
          {!valid && <p role="alert">{t('upload.error')}</p>}
          <details>
            <summary className={advancedSummaryCls}>
              {t('upload.advanced')}
            </summary>
            <div className={advancedBodyCls}>
              {/* 字段标签走 labelMedium,与「导入 / 会议室」等表单同一档;
                  多行输入用共享 TextArea 基元(边框/圆角/焦点态一处定义)。 */}
              <label className={fieldLabelCls}>
                {t('upload.context')}
                <TextArea
                  className={textAreaCls}
                  rows={3}
                  maxLength={400}
                  disabled={busy}
                  value={context}
                  onChange={(event) => {
                    setContext(event.target.value)
                    setKey(crypto.randomUUID())
                  }}
                />
              </label>
              <label className={fieldLabelCls}>
                {t('upload.hotwords')}
                <TextArea
                  className={textAreaCls}
                  rows={3}
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
          <p className={consentCls}>{t('upload.consent')}</p>
          <Button
            type="submit"
            size="action"
            loading={busy}
            isDisabled={!valid}
          >
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
  if (query.isError)
    return <StateHint state="error">{t('upload.stateError')}</StateHint>
  if (!query.data) return <StateHint state="loading">{t('loading')}</StateHint>
  const state = query.data
  if (state.status === 'succeeded') return null
  return (
    <section className={statusSectionCls}>
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
            size="action"
            loading={busy}
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
      {error && <StateHint state="error">{t('upload.error')}</StateHint>}
    </section>
  )
}
