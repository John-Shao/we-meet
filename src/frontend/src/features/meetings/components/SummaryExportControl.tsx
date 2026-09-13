import { readRecovery } from '../hooks/readRecovery'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import ReactMarkdown from 'react-markdown'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'

type Props = {
  recordId: string
  viewerId: string
  sourceId: string
  sourceKind: 'ai' | 'human'
}
type Receipt = {
  id: string
  source_id: string
  source_kind: string
  language: string
  status:
    | 'queued'
    | 'running'
    | 'ready'
    | 'uncertain'
    | 'failed'
    | 'unavailable'
    | 'canceled'
  attempt: number
  document_id: string | null
  can_open: boolean
  error_code: string
}
type Results = { available: boolean; results: Receipt[] }
type Preview = { title: string; markdown: string; payload_hash: string }
type Intent = {
  key: string
  expected_hash: string
  export_id?: string
  expected_attempt?: number
}
const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  minWidth: 0,
})
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function loadIntent(key: string): Intent | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null'
    ) as Intent | null
    if (
      value &&
      uuid.test(value.key) &&
      /^[a-f0-9]{64}$/.test(value.expected_hash) &&
      ((!value.export_id && value.expected_attempt === undefined) ||
        (uuid.test(value.export_id ?? '') &&
          Number.isInteger(value.expected_attempt) &&
          value.expected_attempt! >= 1))
    )
      return value
  } catch {
    /* No content or credentials are stored in the recovery marker. */
  }
}

export const SummaryExportControl = (props: Props) => (
  <Control
    key={`${props.viewerId}:${props.recordId}:${props.sourceKind}:${props.sourceId}`}
    {...props}
  />
)

const Control = (props: Props) => {
  const { t, i18n } = useTranslation('meetings')
  const [opened, setOpened] = useState(false)
  const [language, setLanguage] = useState(
    i18n?.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en'
  )
  const path = `meeting-records/${encodeURIComponent(props.recordId)}/document-exports/`
  const root = useQuery({
    queryKey: ['summary-exports', props.viewerId, props.recordId, path],
    queryFn: ({ signal }) => fetchApi<Results>(path, { signal }),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? false : 5000),
  })
  if (root.isError || (!root.data?.available && !root.data?.results?.length))
    return null
  return (
    <section className={stack}>
      <Button size="sm" variant="tertiary" onPress={() => setOpened(!opened)}>
        {t(opened ? 'summaryExport.close' : 'summaryExport.open')}
      </Button>
      {opened && (
        <>
          <label>
            {t('summaryExport.language')}
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <Text variant="note">{t('summaryExport.languageHint')}</Text>
          <ExportCopy
            key={language}
            {...props}
            language={language}
            path={path}
          />
        </>
      )}
    </section>
  )
}

const ExportCopy = ({
  recordId,
  viewerId,
  sourceId,
  sourceKind,
  language,
  path,
}: Props & { language: string; path: string }) => {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const selection = { source_kind: sourceKind, source_id: sourceId, language }
  const storageKey = `meeting-summary-export:${viewerId}:${recordId}:${sourceKind}:${sourceId}:${language}`
  const [recovery] = useState(() =>
    readRecovery(storageKey, () => loadIntent(storageKey))
  )
  const [intent, setIntent] = useState(recovery.value)
  const [preview, setPreview] = useState<Preview>()
  const [previewAttempt, setPreviewAttempt] = useState<number>()
  const [previewExport, setPreviewExport] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  const query = useQuery({
    queryKey: [
      'summary-export-copy',
      viewerId,
      recordId,
      sourceKind,
      sourceId,
      language,
      path,
    ],
    queryFn: ({ signal }) =>
      fetchApi<Results>(`${path}?${new URLSearchParams(selection)}`, {
        signal,
      }),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (value) => (value.state.status === 'error' ? false : 5000),
  })
  const receipt = query.data?.results?.[0]
  const clearIntent = () => {
    sessionStorage.removeItem(storageKey)
    setIntent(undefined)
  }
  const viewPreview = async () => {
    if (inFlight.current) return
    const signal = lifetime.current!.signal
    inFlight.current = true
    setBusy(true)
    setMessage('')
    setPreview(undefined)
    try {
      const url = receipt
        ? `${path}${encodeURIComponent(receipt.id)}/retry/`
        : `${path}preview/?${new URLSearchParams(selection)}`
      const result = await fetchApi<Preview & { export?: Receipt }>(url, {
        signal,
      })
      if (signal.aborted) return
      setPreview(result)
      setPreviewAttempt(result.export?.attempt)
      setPreviewExport(result.export?.id)
    } catch {
      if (!signal.aborted) setMessage('summaryExport.unavailable')
    } finally {
      inFlight.current = false
      if (!signal.aborted) setBusy(false)
    }
  }
  const submit = async () => {
    if (recovery.blocked) return
    if (inFlight.current || (!intent && !preview)) return
    const signal = lifetime.current!.signal
    const request = intent ?? {
      key: crypto.randomUUID(),
      expected_hash: preview!.payload_hash,
      ...(previewExport
        ? { export_id: previewExport, expected_attempt: previewAttempt }
        : {}),
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request))
    } catch {
      setMessage('summaryExport.storageUnavailable')
      return
    }
    setIntent(request)
    inFlight.current = true
    setBusy(true)
    setMessage('')
    try {
      await fetchApi(
        request.export_id
          ? `${path}${encodeURIComponent(request.export_id)}/retry/`
          : path,
        {
          method: 'POST',
          signal,
          headers: { 'Idempotency-Key': request.key },
          meetingCommand: { key: request.key, scope: { record_id: recordId } },
          body: JSON.stringify(
            request.export_id
              ? {
                  expected_attempt: request.expected_attempt,
                  expected_hash: request.expected_hash,
                }
              : { ...selection, expected_hash: request.expected_hash }
          ),
        }
      )
      if (signal.aborted) return
      clearIntent()
      setPreview(undefined)
      setMessage('summaryExport.accepted')
    } catch (error) {
      if (signal.aborted) return
      if (
        error instanceof ApiError &&
        [400, 409, 422].includes(error.statusCode)
      ) {
        clearIntent()
        setPreview(undefined)
        setMessage(
          error.statusCode === 409
            ? 'summaryExport.conflict'
            : 'summaryExport.unavailable'
        )
      } else setMessage('summaryExport.uncertain')
    } finally {
      inFlight.current = false
      if (!signal.aborted) {
        setBusy(false)
        await Promise.allSettled([
          query.refetch(),
          client.invalidateQueries({
            queryKey: ['summary-exports', viewerId, recordId],
          }),
        ])
      }
    }
  }
  if (recovery.blocked)
    return <Text>{t('summaryExport.storageUnavailable')}</Text>
  if (query.isError) return <Text>{t('summaryExport.unavailable')}</Text>
  if (!query.data) return <Text>{t('loading')}</Text>
  const retryable =
    receipt &&
    ['failed', 'uncertain', 'canceled'].includes(receipt.status) &&
    receipt.attempt < 20 &&
    receipt.error_code !== 'document_conflict'
  const maySubmit =
    !!intent || (query.data.available && (!receipt || retryable))
  return (
    <div className={stack}>
      <Text variant="note">{t('summaryExport.copyHint')}</Text>
      {receipt && (
        <div role="status">{t(`summaryExport.status.${receipt.status}`)}</div>
      )}
      {receipt?.status === 'ready' &&
        receipt.document_id &&
        receipt.can_open && (
          <Link href={`/docs/${encodeURIComponent(receipt.document_id)}`}>
            {t('summaryExport.openDocument')}
          </Link>
        )}
      {intent ? (
        <>
          <Text>{t('summaryExport.pendingHint')}</Text>
          <Button size="sm" isDisabled={busy} onPress={() => void submit()}>
            {t('summaryExport.resubmit')}
          </Button>
        </>
      ) : (
        <>
          {(query.data.available || receipt) && (
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={busy}
              onPress={() => void viewPreview()}
            >
              {t('summaryExport.preview')}
            </Button>
          )}
          {preview && (
            <>
              <h4>{preview.title}</h4>
              <div
                aria-label={t('summaryExport.content')}
                className={css({
                  overflowWrap: 'anywhere',
                  maxHeight: '24rem',
                  overflow: 'auto',
                  padding: '0.75rem',
                  border: '1px solid',
                  borderColor: 'greyscale.200',
                  borderRadius: '6px',
                  '& h1, & h2': { fontWeight: 600, marginBottom: '0.75rem' },
                  '& h1': { fontSize: '1.125rem' },
                  '& h2': { marginTop: '1rem' },
                  '& p': { marginBottom: '0.75rem', whiteSpace: 'pre-wrap' },
                  '& ul': { paddingLeft: '1.25rem', listStyleType: 'disc' },
                })}
              >
                <ReactMarkdown
                  skipHtml
                  allowedElements={[
                    'h1',
                    'h2',
                    'h3',
                    'p',
                    'ul',
                    'ol',
                    'li',
                    'strong',
                    'em',
                    'code',
                    'br',
                    'blockquote',
                  ]}
                >
                  {preview.markdown}
                </ReactMarkdown>
              </div>
              {maySubmit && (
                <Button
                  size="sm"
                  isDisabled={
                    busy ||
                    (!!receipt &&
                      (previewExport !== receipt.id ||
                        previewAttempt !== receipt.attempt))
                  }
                  onPress={() => void submit()}
                >
                  {t(
                    receipt
                      ? 'summaryExport.confirmRetry'
                      : 'summaryExport.confirm'
                  )}
                </Button>
              )}
            </>
          )}
        </>
      )}
      {message && <div role="status">{t(message)}</div>}
      <Button
        size="sm"
        variant="tertiary"
        isDisabled={busy}
        onPress={() => void query.refetch()}
      >
        {t('recordAi.refresh')}
      </Button>
    </div>
  )
}
