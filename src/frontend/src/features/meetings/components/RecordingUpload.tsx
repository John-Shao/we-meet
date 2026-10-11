import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { uploadFetch } from '@/api/uploadFetch'
import { Button, Dialog, TextArea } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { StateHint } from '@/components/StateHint'
import { RiDownload2Line } from '@remixicon/react'
import { css, cx } from '@/styled-system/css'
import { rowMeta } from './libraryStyles'
import { PersonalHotwords } from './PersonalHotwords'
import {
  CHUNKED_THRESHOLD,
  forgetSession,
  putPartWithProgress,
  UploadCancelled,
  uploadInParts,
} from '../chunkedUpload'
import { formatDecimal } from '../recordDateTime'
import {
  getAuthSnapshot,
  sameAuthSession,
} from '@/features/auth/utils/tokenStorage'
import { ImportIdentityChoices } from '@/features/voiceprint/ImportIdentityChoices'
import {
  boundImportRequest,
  ImportIdentityClient,
  type ImportIdentity,
  type ImportIdentityCapability,
  type ImportRequest,
} from '@/features/voiceprint/importIdentity'

type UploadState = {
  record_id: string
  status: 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed'
  attempt: number
  retryable: boolean
  error_code: string
  identity_preflight?: {
    status: string
    reason: string
    can_continue_without_identity: boolean
  }
  identity_request?: {
    status: 'queued' | 'running' | 'submitted' | 'unavailable'
    reason: string
  }
}

/** What the server can accept, and by which of the two paths. */
type UploadCapabilities = {
  personal_hotwords_available?: boolean
  available: boolean
  /** The multipart branch's hard ceiling. */
  max_bytes: number
  extensions: string[]
  /** True once the server offers presigned direct uploads. */
  direct_upload_available?: boolean
  /** The direct branch's ceiling, 0 when direct uploads are off. */
  direct_max_bytes?: number
  identity_preflight?: ImportIdentityCapability
}

type DirectUploadTicket = {
  upload_url: string
  storage_name: string
  headers: Record<string, string>
  uploaded?: boolean
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
  options: {
    context: string
    hotwords: string
    diarization: boolean
    identity?: ImportIdentity
  },
  direct: { maxBytes: number } | null,
  ticket: { current: DirectUploadTicket | null },
  signal: AbortSignal,
  onProgress: (sent: number, total: number) => void,
  request: ImportRequest
): Promise<UploadState> {
  const content_type = file.type || 'application/octet-stream'
  if (!direct || file.size > direct.maxBytes) {
    const body = new FormData()
    body.set('key', key)
    body.set('audio', file)
    body.set('context', options.context)
    body.set('hotwords', options.hotwords)
    body.set('diarization', String(options.diarization))
    if (options.identity) body.set('identity', JSON.stringify(options.identity))
    return request<UploadState>('recording-uploads/', {
      method: 'POST',
      body,
      signal,
      onUploadProgress: onProgress,
    })
  }

  ticket.current ??= await request<DirectUploadTicket>(DIRECT, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
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
  if (!ticket.current.uploaded) {
    let stored = false
    try {
      const response = await uploadFetch(
        ticket.current.upload_url,
        {
          method: 'PUT',
          headers: ticket.current.headers,
          body: file,
          signal,
          credentials: 'omit',
        },
        onProgress
      )
      stored = response.ok
    } catch {
      stored = false
    }
    if (!stored) {
      // The transfer broke; a retry needs a fresh ticket.
      ticket.current = null
      throw new Error('direct upload failed')
    }
    ticket.current.uploaded = true
  }

  signal.throwIfAborted()
  onProgress(file.size, file.size)

  return request<UploadState>(COMPLETE, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
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
  minWidth: 0,
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

type UploadProps = { viewerId: string; onRecord?: (id: string) => void }

function useLoginKey() {
  const [session, setSession] = useState(() => getAuthSnapshot().session)
  useEffect(() => {
    const check = () => setSession(getAuthSnapshot().session)
    const timer = setInterval(check, 250)
    window.addEventListener('storage', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('storage', check)
    }
  }, [])
  return session
}

export function RecordingUpload(props: UploadProps) {
  const session = useLoginKey()
  return (
    <RecordingUploadSession key={`${props.viewerId}:${session}`} {...props} />
  )
}

function RecordingUploadSession({ viewerId, onRecord }: UploadProps) {
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
  const [diarization, setDiarization] = useState(false)
  const [identity, setIdentity] = useState<ImportIdentity | null>(null)
  const [identityReady, setIdentityReady] = useState(false)
  const auth = useRef(getAuthSnapshot()).current
  const request = useMemo(
    () => boundImportRequest(viewerId, auth, identity !== null),
    [viewerId, auth, identity]
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  // Once sent, keep the declaration stable until its result is known.
  const [submitted, setSubmitted] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [uploadTotal, setUploadTotal] = useState(0)
  // Transport progress is not a successful import receipt.
  const [uploaded, setUploaded] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      controller.current?.abort()
      ticket.current = null
      forgetSession(key)
    },
    [key]
  )
  const capabilities = useQuery({
    queryKey: ['recording-upload-capabilities', viewerId, auth.session],
    queryFn: ({ signal }) =>
      request<UploadCapabilities>('recording-uploads/', {
        signal,
        cache: 'no-store',
      }),
    retry: false,
    gcTime: 0,
  })
  if (!capabilities.data?.available || !sameAuthSession(auth)) return null
  const config = capabilities.data
  // When the server offers direct uploads, that path's ceiling is the real one;
  // the multipart ceiling only still applies to the legacy branch.
  const directAllowed =
    config.direct_upload_available === true &&
    (config.direct_max_bytes ?? 0) > 0
  const limit = directAllowed
    ? Math.max(config.max_bytes, config.direct_max_bytes ?? 0)
    : config.max_bytes
  const extension = file?.name.split('.').pop()?.toLowerCase() ?? ''
  // Past the threshold a single PUT means one break loses everything, so large
  // files go up in parts. Small ones keep the simpler whole-file path.
  const chunked = directAllowed && (file?.size ?? 0) > CHUNKED_THRESHOLD
  const percent = uploadTotal
    ? Math.min(100, Math.floor((uploaded / uploadTotal) * 100))
    : 0
  const validFile =
    !!file &&
    file.size > 0 &&
    file.size <= limit &&
    config.extensions.includes(extension)
  const identityEligible =
    config.identity_preflight?.available === true &&
    !!file &&
    file.size <= (config.identity_preflight.max_bytes ?? 0)
  const valid =
    validFile &&
    (identity === null ||
      submitted ||
      (identityReady &&
        identityEligible &&
        identity.candidate_user_ids.length > 0 &&
        identity.candidate_user_ids.length <=
          (config.identity_preflight?.max_candidates ?? 0)))
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
          setIdentity(null)
          setKey(crypto.randomUUID())
          // A ticket belongs to one file's bytes; a different file needs its own.
          ticket.current = null
          setSubmitted(false)
          setStopped(false)
          setCancelled(false)
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
              !valid ||
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
            setSubmitted(true)
            setStopped(false)
            setCancelled(false)
            setUploaded(0)
            setUploadTotal(file.size)
            const abort = new AbortController()
            controller.current = abort
            const progress = (sent: number, total: number) => {
              setUploaded(sent)
              setUploadTotal(total)
            }
            try {
              let recordId: string
              if (chunked) {
                try {
                  const job = (await uploadInParts(
                    file,
                    key,
                    {
                      name: file.name,
                      content_type: file.type || 'application/octet-stream',
                      context,
                      hotwords,
                      diarization,
                      ...(identity ? { identity } : {}),
                    },
                    { request, putPart: putPartWithProgress },
                    abort.signal,
                    progress
                  )) as UploadState
                  recordId = job.record_id
                } catch (failure) {
                  if (failure instanceof UploadCancelled) {
                    setCancelled(true)
                    return
                  }
                  throw failure
                } finally {
                  controller.current = null
                }
              } else {
                const result = await importRecording(
                  file,
                  key,
                  {
                    context,
                    hotwords,
                    diarization,
                    ...(identity ? { identity } : {}),
                  },
                  directAllowed ? { maxBytes: limit } : null,
                  ticket,
                  abort.signal,
                  progress,
                  request
                )
                recordId = result.record_id
              }
              if (!sameAuthSession(auth) || abort.signal.aborted) return
              setOpen(false)
              if (onRecord) onRecord(recordId)
              else navigate(`/meeting/records/${recordId}?tab=text`)
            } catch {
              if (abort.signal.aborted && !chunked) setStopped(true)
              else setError(true)
            } finally {
              controller.current = null
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
              ? formatDecimal(file.size / 1024 / 1024, undefined, {
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
          {!validFile && <p role="alert">{t('upload.error')}</p>}
          {(config.identity_preflight?.available || identity) && (
            <>
              <Checkbox
                isSelected={identity !== null}
                isDisabled={
                  busy || submitted || (identity === null && !identityEligible)
                }
                onChange={(checked) => {
                  setIdentity(
                    checked
                      ? { organization_id: null, candidate_user_ids: [] }
                      : null
                  )
                  if (checked) setDiarization(true)
                  setKey(crypto.randomUUID())
                }}
                description={t('upload.identityHint')}
              >
                {t('upload.identity')}
              </Checkbox>
              {!identityEligible && (
                <p>
                  {t(
                    config.identity_preflight?.available
                      ? 'upload.identityLimit'
                      : 'upload.identityUnavailable'
                  )}
                </p>
              )}
              {identity && (
                <ImportIdentityChoices
                  viewerId={viewerId}
                  value={identity}
                  disabled={busy || submitted}
                  onReady={setIdentityReady}
                  maxCandidates={config.identity_preflight?.max_candidates ?? 0}
                  onChange={(value) => {
                    if (busy || submitted) return
                    setIdentity(value)
                    setKey(crypto.randomUUID())
                  }}
                />
              )}
            </>
          )}
          <details>
            <summary className={advancedSummaryCls}>
              {t('upload.advanced')}
            </summary>
            <div className={advancedBodyCls}>
              <Checkbox
                isSelected={diarization}
                isDisabled={busy || submitted}
                onChange={(value) => {
                  setDiarization(value)
                  if (!value) setIdentity(null)
                  setKey(crypto.randomUUID())
                }}
                description={t('upload.diarizationHint')}
              >
                {t('upload.diarization')}
              </Checkbox>
              {/* 字段标签走 labelMedium,与「导入 / 会议室」等表单同一档;
                  多行输入用共享 TextArea 基元(边框/圆角/焦点态一处定义)。 */}
              <label className={fieldLabelCls}>
                {t('upload.context')}
                <TextArea
                  className={textAreaCls}
                  rows={3}
                  maxLength={400}
                  disabled={busy || submitted}
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
                  disabled={busy || submitted}
                  value={hotwords}
                  onChange={(event) => {
                    setHotwords(event.target.value)
                    setKey(crypto.randomUUID())
                  }}
                />
              </label>
              {config.personal_hotwords_available && (
                <PersonalHotwords
                  viewerId={viewerId}
                  value={hotwords}
                  disabled={busy || submitted}
                  onApply={(value) => {
                    if (busy || submitted) return
                    setHotwords(value)
                    setKey(crypto.randomUUID())
                  }}
                />
              )}
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
          {/* A GB-scale import takes minutes, so it needs a real number and a
              way out rather than an indefinite spinner. The native <progress>
              already carries the progressbar role and its own values, so the
              wrapper must not declare a second one. */}
          {busy && (
            <div
              className={css({
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'center',
              })}
            >
              <progress
                value={uploaded}
                max={Math.max(uploadTotal, 1)}
                aria-label={t('upload.progress', { percent })}
              />
              <span>{t('upload.progress', { percent })}</span>
            </div>
          )}
          {busy && (
            <Button
              variant="secondaryText"
              size="dense"
              onPress={() => controller.current?.abort()}
            >
              {t('upload.cancel')}
            </Button>
          )}
          {busy && !chunked && <p role="status">{t('upload.keepOpen')}</p>}
          {busy && percent === 100 && (
            <p role="status">{t('upload.confirming')}</p>
          )}
          {stopped && <p role="status">{t('upload.stopped')}</p>}
          {cancelled && <p role="status">{t('upload.cancelled')}</p>}
          {error && valid && <p role="alert">{t('upload.error')}</p>}
        </form>
      </Dialog>
    </>
  )
}

export function UploadedRecordingStatus(props: {
  recordId: string
  viewerId: string
}) {
  const session = useLoginKey()
  return (
    <UploadedRecordingStatusSession
      key={`${props.viewerId}:${props.recordId}:${session}`}
      {...props}
    />
  )
}

function UploadedRecordingStatusSession({
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
  const auth = useRef(getAuthSnapshot()).current
  const request = useMemo(
    () => boundImportRequest(viewerId, auth, false),
    [viewerId, auth]
  )
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  const query = useQuery({
    queryKey: ['recording-upload-state', viewerId, recordId, auth.session],
    queryFn: async ({ signal }) => {
      const state = await request<UploadState>(
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
      q.state.data?.status === 'failed' ||
      (q.state.data?.status === 'succeeded' &&
        !['queued', 'running'].includes(
          q.state.data.identity_request?.status ?? ''
        ))
        ? false
        : 5000,
  })
  if (!sameAuthSession(auth)) return null
  if (query.isError)
    return <StateHint state="error">{t('upload.stateError')}</StateHint>
  if (!query.data) return <StateHint state="loading">{t('loading')}</StateHint>
  const state = query.data
  const dispatch = state.identity_request
  if (state.status === 'succeeded')
    return dispatch ? (
      <p role="status">{t(`upload.identityRequest.${dispatch.status}`)}</p>
    ) : null
  return (
    <section className={statusSectionCls}>
      <p role="status">
        {t(
          state.identity_preflight?.can_continue_without_identity
            ? 'upload.preflightStopped'
            : `upload.status.${state.status}`
        )}
      </p>
      {state.status === 'queued' &&
        state.identity_preflight &&
        ['pending', 'preflighting', 'ready'].includes(
          state.identity_preflight.status
        ) && (
          <p role="status">
            {t(
              state.identity_preflight.status === 'ready'
                ? 'upload.preflightReady'
                : 'upload.preflightPending'
            )}
          </p>
        )}
      {state.identity_preflight?.can_continue_without_identity && (
        <>
          <p>{t('upload.preflightFailed')}</p>
          <div
            className={css({ display: 'flex', flexWrap: 'wrap', gap: 'sm' })}
          >
            {(['retry_identity', 'continue_without_identity'] as const).map(
              (action) => (
                <Button
                  key={action}
                  size="action"
                  loading={busy}
                  isDisabled={busy}
                  onPress={async () => {
                    setBusy(true)
                    setError(false)
                    try {
                      await new ImportIdentityClient(viewerId, auth).decide(
                        recordId,
                        state.attempt,
                        action,
                        lifetime.current.signal
                      )
                      if (
                        sameAuthSession(auth) &&
                        !lifetime.current.signal.aborted
                      )
                        await query.refetch()
                    } catch {
                      if (
                        sameAuthSession(auth) &&
                        !lifetime.current.signal.aborted
                      )
                        setError(true)
                    } finally {
                      if (
                        sameAuthSession(auth) &&
                        !lifetime.current.signal.aborted
                      )
                        setBusy(false)
                    }
                  }}
                >
                  {t(`upload.preflightDecision.${action}`)}
                </Button>
              )
            )}
          </div>
        </>
      )}
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
                await request(`recording-uploads/${recordId}/`, {
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
      {error && (
        <StateHint
          state="error"
          action={
            <Button size="dense" onPress={() => void query.refetch()}>
              {t('library.refresh')}
            </Button>
          }
        >
          {t('upload.error')}
        </StateHint>
      )}
    </section>
  )
}
