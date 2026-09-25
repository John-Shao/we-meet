import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { RiFindReplaceLine } from '@remixicon/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'
import { formatDateTime } from '../recordDateTime'
import { receiptRole } from './liveRegionRole'

type Preview = {
  preview_hash: string
  occurrences: number
  changes: { id: string; before: string; after: string; start_ms: number }[]
}
type Receipt = {
  id: string
  find: string
  replacement: string
  changed_segments: number
  created_at: string
  undone: boolean
}
type Intent = {
  key: string
  expected_hash: string
  find: string
  replacement: string
}
const stack = css({ display: 'flex', flexDirection: 'column', gap: 'md' })

// Only the retry marker is persisted, never a preview or a transcript copy.
function load(key: string): Intent | null {
  const raw = sessionStorage.getItem(key)
  if (!raw) return null
  if (raw.length > 4096) throw new Error('Invalid recovery marker')
  const value = JSON.parse(raw) as Intent
  if (
    !/^[a-f0-9-]{36}$/i.test(value.key) ||
    !/^[a-f0-9]{64}$/.test(value.expected_hash) ||
    typeof value.find !== 'string' ||
    !value.find.trim() ||
    value.find.length > 200 ||
    typeof value.replacement !== 'string' ||
    value.replacement.length > 200
  )
    throw new Error('Invalid recovery marker')
  return value
}

export function TranscriptReplacementControl(props: {
  viewerId: string
  recordId: string
  render?: (trigger: ReactNode, panel: ReactNode) => ReactNode
}) {
  return <Control key={`${props.viewerId}:${props.recordId}`} {...props} />
}

function Control({
  viewerId,
  recordId,
  render,
}: {
  viewerId: string
  recordId: string
  render?: (trigger: ReactNode, panel: ReactNode) => ReactNode
}) {
  const { t } = useTranslation('meetings')
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const client = useQueryClient()
  const path = `meeting-records/${encodeURIComponent(recordId)}/transcript-replacements/`
  const storageKey = `transcript-replacement:${viewerId}:${recordId}`
  const [recovery] = useState(() => {
    try {
      return { intent: load(storageKey), failed: false }
    } catch {
      return { intent: null, failed: true }
    }
  })
  const [open, setOpen] = useState(!!recovery.intent)
  const [find, setFind] = useState(recovery.intent?.find ?? '')
  const [replacement, setReplacement] = useState(
    recovery.intent?.replacement ?? ''
  )
  const [intent, setIntent] = useState<Intent | null>(recovery.intent)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [undoId, setUndoId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(recovery.failed ? 'storageError' : '')
  const active = useRef(true)
  const writing = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const history = useQuery({
    queryKey: ['transcript-replacements', viewerId, recordId, path],
    queryFn: ({ signal }) =>
      fetchApi<{ results: Receipt[] }>(path, { signal, cache: 'no-store' }),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 15000),
  })
  useEffect(() => {
    if (history.isError) setPreview(null)
  }, [history.isError])
  const refresh = () => {
    for (const key of [
      ['meeting-records', viewerId],
      ['capture-originals', viewerId],
      ['record-library-content', viewerId],
      ['transcript-replacements', viewerId, recordId],
    ])
      void client.invalidateQueries({ queryKey: key })
  }
  const run = async (kind: 'preview' | 'apply' | 'undo') => {
    if (writing.current || recovery.failed || history.isError) return
    writing.current = true
    setBusy(true)
    setMessage('')
    try {
      if (kind === 'preview') {
        setPreview(null)
        const result = await fetchApi<Preview>(`${path}preview/`, {
          method: 'POST',
          body: JSON.stringify({ find, replacement }),
        })
        if (active.current) setPreview(result)
      } else if (kind === 'apply') {
        const body = intent ?? {
          key: crypto.randomUUID(),
          find,
          replacement,
          expected_hash: preview!.preview_hash,
        }
        // Persist before sending; an uncertain response must retry this exact key/body.
        sessionStorage.setItem(storageKey, JSON.stringify(body))
        setIntent(body)
        const receipt = await fetchApi<Receipt>(path, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        sessionStorage.removeItem(storageKey)
        if (active.current) {
          setIntent(null)
          setPreview(null)
          setMessage(receipt.undone ? 'undone' : 'applied')
          refresh()
        }
      } else {
        await fetchApi<Receipt>(`${path}${encodeURIComponent(undoId!)}/undo/`, {
          method: 'POST',
        })
        if (active.current) {
          setUndoId(null)
          setPreview(null)
          setMessage('undone')
          refresh()
        }
      }
    } catch (error) {
      if (!active.current) return
      const status = error instanceof ApiError ? error.statusCode : 0
      if (kind === 'apply' && [400, 409].includes(status)) {
        try {
          sessionStorage.removeItem(storageKey)
          setIntent(null)
        } catch {
          /* Keep retry marker on failure. */
        }
        setPreview(null)
      }
      if ([401, 403, 404].includes(status)) {
        setPreview(null)
        void history.refetch()
        refresh()
      }
      setMessage(
        status === 409 ? 'conflict' : status === 400 ? 'invalid' : 'error'
      )
    } finally {
      writing.current = false
      if (active.current) setBusy(false)
    }
  }
  const close = () => {
    setOpen(false)
    setPreview(null)
    setUndoId(null)
    triggerRef.current?.focus()
  }
  const trigger = (
    <Button
      ref={triggerRef}
      size="sm"
      variant="secondaryText"
      icon={<RiFindReplaceLine size={16} aria-hidden />}
      aria-label={t('batchCorrection.title')}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      isDisabled={busy}
      onPress={() => (open ? close() : setOpen(true))}
    >
      {t(render ? 'transcriptToolbar.replace' : 'batchCorrection.title')}
    </Button>
  )
  if (!open) return render ? render(trigger, null) : trigger
  const locked =
    busy ||
    !!intent ||
    !!undoId ||
    recovery.failed ||
    history.isError ||
    !history.data
  const panel = (
    <section
      id={panelId}
      className={stack}
      aria-label={t('batchCorrection.title')}
    >
      <h3>{t('batchCorrection.title')}</h3>
      <p>{t('batchCorrection.hint')}</p>
      {/* 两个查找/替换框此前是裸 `<input>`(无 className) —— 浏览器默认外观在深色
          主题下不跟随主题。走共享 `Input`,与同面板的其它控件同一套几何与状态。 */}
      <label>
        {t('batchCorrection.find')}
        <Input
          aria-label={t('batchCorrection.find')}
          value={find}
          maxLength={200}
          disabled={locked}
          onChange={(e) => {
            setFind(e.target.value)
            setPreview(null)
            setMessage('')
          }}
        />
      </label>
      <label>
        {t('batchCorrection.replacement')}
        <Input
          aria-label={t('batchCorrection.replacement')}
          value={replacement}
          maxLength={200}
          disabled={locked}
          onChange={(e) => {
            setReplacement(e.target.value)
            setPreview(null)
            setMessage('')
          }}
        />
      </label>
      {intent ? (
        <>
          <p>{t('batchCorrection.pending')}</p>
          <Button
            isDisabled={busy || history.isError || !history.data}
            onPress={() => void run('apply')}
          >
            {t('batchCorrection.retry')}
          </Button>
        </>
      ) : (
        <Button
          isDisabled={locked || !find.trim() || find === replacement}
          onPress={() => void run('preview')}
        >
          {t('batchCorrection.preview')}
        </Button>
      )}
      {preview && !history.isError && !intent && (
        <>
          <p>
            {t('batchCorrection.count', {
              segments: preview.changes.length,
              count: preview.occurrences,
            })}
          </p>
          <div
            className={css({
              maxHeight: '24rem',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            })}
          >
            {preview.changes.map((row) => (
              <article key={row.id}>
                <p>{Math.floor(row.start_ms / 1000)}s</p>
                <p>
                  {t('batchCorrection.before')}: {row.before}
                </p>
                <p>
                  {t('batchCorrection.after')}: {row.after}
                </p>
              </article>
            ))}
          </div>
          <Button
            isDisabled={locked || preview.changes.length === 0}
            onPress={() => void run('apply')}
          >
            {t('batchCorrection.confirm')}
          </Button>
        </>
      )}
      {message && (
        <p role={receiptRole(message)}>{t(`batchCorrection.${message}`)}</p>
      )}
      <h4>{t('batchCorrection.history')}</h4>
      {history.isError ? (
        <Button onPress={() => void history.refetch()}>
          {t('library.refresh')}
        </Button>
      ) : (
        history.data?.results.map((row) => (
          <article key={row.id}>
            <p>
              {row.find} → {row.replacement || t('batchCorrection.deleted')} ·{' '}
              {row.changed_segments} · {formatDateTime(row.created_at)}
            </p>
            {row.undone ? (
              <p>{t('batchCorrection.undone')}</p>
            ) : (
              <Button
                size="dense"
                isDisabled={locked}
                onPress={() => {
                  setUndoId(row.id)
                  setPreview(null)
                  setMessage('')
                }}
              >
                {t('batchCorrection.undo')}
              </Button>
            )}
          </article>
        ))
      )}
      {undoId && (
        <>
          <p>{t('batchCorrection.undoHint')}</p>
          <Button
            isDisabled={busy || history.isError || !history.data}
            onPress={() => void run('undo')}
          >
            {t('batchCorrection.confirmUndo')}
          </Button>
          <Button
            isDisabled={busy}
            variant="secondaryText"
            onPress={() => setUndoId(null)}
          >
            {t('library.renameCancel')}
          </Button>
        </>
      )}
      <Button variant="secondaryText" isDisabled={busy} onPress={close}>
        {t('batchCorrection.close')}
      </Button>
    </section>
  )
  return render ? render(trigger, panel) : panel
}
