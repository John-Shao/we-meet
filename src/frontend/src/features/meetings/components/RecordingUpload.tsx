import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { Button, Dialog, TextArea } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { RiUpload2Line } from '@remixicon/react'
import { css, cx } from '@/styled-system/css'
import { entryTile, rowMeta } from './libraryStyles'

type UploadState = {
  record_id: string
  status: 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed'
  attempt: number
  retryable: boolean
  error_code: string
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
          className={cx(entryTile, css({ flexShrink: 0 }))}
        >
          <RiUpload2Line size={32} aria-hidden />
          {t('upload.open')}
        </button>
      ) : (
        <Button
          variant="secondary"
          size="action"
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
          className={formCls}
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
