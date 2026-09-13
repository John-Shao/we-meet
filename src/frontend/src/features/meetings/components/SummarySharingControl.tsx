import { readRecovery } from '../hooks/readRecovery'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'

type Props = { recordId: string; viewerId: string; online: boolean }
type Person = { id: string; name: string }
type Grant = Person & {
  active: boolean
  read_summary: boolean
  read_transcript: boolean
}
type Page<T> = { results: T[]; next_cursor: string | null }
type Access = Page<Grant> & { available: boolean; can_manage: boolean }
type Selection = { user_ids: string[]; operation: 'grant' | 'revoke' }
type Preview = {
  title: string
  preview_hash: string
  recipients: (Person & {
    after_effective_summary: boolean
    inherited_summary: boolean
    effective_transcript: boolean
  })[]
}
type Intent = Selection & { key: string; expected_hash: string }
const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  minWidth: 0,
  overflowWrap: 'anywhere',
})
const line = css({
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap',
  alignItems: 'center',
})
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
function loadIntent(key: string): Intent | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null'
    ) as Intent | null
    if (
      value &&
      uuid.test(value.key) &&
      /^[a-f0-9]{64}$/.test(value.expected_hash) &&
      ['grant', 'revoke'].includes(value.operation) &&
      Array.isArray(value.user_ids) &&
      value.user_ids.length > 0 &&
      value.user_ids.length <= 50 &&
      value.user_ids.every((id) => uuid.test(id))
    )
      return value
  } catch {
    /* Only request IDs and hashes are kept for ambiguous-result recovery. */
  }
}

export const SummarySharingControl = (props: Props) => (
  <Control key={`${props.viewerId}:${props.recordId}`} {...props} />
)

function Control(props: Props) {
  const { t } = useTranslation('meetings')
  const [opened, setOpened] = useState(false)
  const path = `meeting-records/${encodeURIComponent(props.recordId)}/summary-sharing/`
  const query = useQuery({
    queryKey: ['summary-sharing', props.viewerId, props.recordId, path],
    queryFn: ({ signal }) =>
      fetchApi<Access>(path, { signal, cache: 'no-store' }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 5000),
  })
  if (query.isError)
    return (
      <div className={stack}>
        <Text>{t('summarySharing.loadError')}</Text>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => void query.refetch()}
        >
          {t('recordAi.refresh')}
        </Button>
      </div>
    )
  if (!query.data?.can_manage) return null
  return (
    <section className={stack} aria-label={t('summarySharing.title')}>
      <Button size="sm" variant="tertiary" onPress={() => setOpened(!opened)}>
        {t(opened ? 'summarySharing.close' : 'summarySharing.title')}
      </Button>
      {opened && (
        <Editor
          {...props}
          path={path}
          available={query.data.available}
          refresh={() => void query.refetch()}
        />
      )}
    </section>
  )
}

function Editor({
  recordId,
  viewerId,
  online,
  path,
  available,
  refresh,
}: Props & { path: string; available: boolean; refresh: () => void }) {
  const { t } = useTranslation('meetings')
  const [cursor, setCursor] = useState<string>()
  const [selection, setSelection] = useState<Selection>({
    user_ids: [],
    operation: 'grant',
  })
  const [preview, setPreview] = useState<Preview>()
  const storageKey = `meeting-summary-sharing:${viewerId}:${recordId}`
  const [recovery] = useState(() =>
    readRecovery(storageKey, () => loadIntent(storageKey))
  )
  const [intent, setIntent] = useState(recovery.value)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  const grants = useQuery({
    queryKey: ['summary-sharing-grants', viewerId, recordId, path, cursor],
    queryFn: ({ signal }) =>
      fetchApi<Access>(
        `${path}?${new URLSearchParams(cursor ? { cursor } : {})}`,
        { signal, cache: 'no-store' }
      ),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 5000),
  })
  const inspect = async (next: Selection) => {
    if (inFlight.current || !next.user_ids.length) return
    setSelection(next)
    const signal = lifetime.current!.signal
    inFlight.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await fetchApi<Preview>(`${path}preview/`, {
        method: 'POST',
        signal,
        body: JSON.stringify(next),
      })
      if (!signal.aborted) setPreview(result)
    } catch {
      if (!signal.aborted) setMessage('summarySharing.previewError')
    } finally {
      inFlight.current = false
      if (!signal.aborted) setBusy(false)
    }
  }
  const submit = async () => {
    if (recovery.blocked) return
    if (inFlight.current || (!intent && !preview)) return
    const request = intent ?? {
      ...selection,
      key: crypto.randomUUID(),
      expected_hash: preview!.preview_hash,
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request))
    } catch {
      setMessage('summarySharing.storageUnavailable')
      return
    }
    const signal = lifetime.current!.signal
    setIntent(request)
    inFlight.current = true
    setBusy(true)
    setMessage('')
    const clear = () => {
      sessionStorage.removeItem(storageKey)
      setIntent(undefined)
      setPreview(undefined)
    }
    try {
      await fetchApi(path, {
        method: 'POST',
        signal,
        headers: { 'Idempotency-Key': request.key },
        meetingCommand: { key: request.key, scope: { record_id: recordId } },
        body: JSON.stringify({
          user_ids: request.user_ids,
          operation: request.operation,
          expected_hash: request.expected_hash,
        }),
      })
      if (signal.aborted) return
      clear()
      setSelection({ user_ids: [], operation: 'grant' })
      setMessage('summarySharing.accepted')
    } catch (error) {
      if (signal.aborted) return
      if (
        error instanceof ApiError &&
        [400, 409, 422].includes(error.statusCode)
      ) {
        clear()
        setMessage(
          error.statusCode === 409
            ? 'summarySharing.conflict'
            : 'summarySharing.loadError'
        )
      } else setMessage('summarySharing.uncertain')
    } finally {
      inFlight.current = false
      if (!signal.aborted) {
        setBusy(false)
        void grants.refetch()
        refresh()
      }
    }
  }
  if (recovery.blocked)
    return <Text>{t('summarySharing.storageUnavailable')}</Text>
  if (grants.isError || (grants.data && !grants.data.can_manage))
    return <Text>{t('summarySharing.loadError')}</Text>
  if (!grants.data) return <Text>{t('loading')}</Text>
  return (
    <div className={stack}>
      <Text>{t('summarySharing.scope')}</Text>
      <Text variant="note">{t('summarySharing.boundaries')}</Text>
      {!available && <Text>{t('summarySharing.paused')}</Text>}
      {intent ? (
        <>
          <Text>
            {t('summarySharing.pending', { count: intent.user_ids.length })}
          </Text>
          <Button size="sm" isDisabled={busy} onPress={() => void submit()}>
            {t('summarySharing.resubmit')}
          </Button>
        </>
      ) : preview ? (
        <>
          <h3>
            {t('summarySharing.previewTitle')} · {preview.title}
          </h3>
          <Text>{t(`summarySharing.operation.${selection.operation}`)}</Text>
          <ul className={stack}>
            {preview.recipients.map((person) => (
              <li key={person.id}>
                <strong>{person.name || t('summaryNotice.unnamed')}</strong>
                <p>
                  {t(
                    person.after_effective_summary
                      ? 'summarySharing.willRead'
                      : 'summarySharing.willLose'
                  )}
                </p>
                {person.inherited_summary && (
                  <p>{t('summarySharing.inherited')}</p>
                )}
                {person.effective_transcript && (
                  <p>{t('summarySharing.originalAccess')}</p>
                )}
              </li>
            ))}
          </ul>
          <div className={line}>
            <Button
              size="sm"
              isDisabled={busy || !available || !grants.data.available}
              onPress={() => void submit()}
            >
              {t('summarySharing.confirm')}
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={busy}
              onPress={() => setPreview(undefined)}
            >
              {t('summarySharing.back')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {available && grants.data.available && (
            <Candidates
              key={`${selection.operation}:${message}`}
              viewerId={viewerId}
              path={path}
              online={online}
              disabled={busy}
              onPreview={(ids) =>
                void inspect({ user_ids: ids, operation: 'grant' })
              }
            />
          )}
          <h3>{t('summarySharing.existing')}</h3>
          {!grants.data.results.length && (
            <Text>{t('summarySharing.empty')}</Text>
          )}
          <ul className={stack}>
            {grants.data.results.map((person) => (
              <li key={person.id}>
                <div className={line}>
                  <Text>
                    {person.name || t('summaryNotice.unnamed')}
                    {!person.active && ` · ${t('summarySharing.inactive')}`}
                  </Text>
                  {person.read_summary &&
                    available &&
                    grants.data!.available && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={busy}
                        onPress={() =>
                          void inspect({
                            user_ids: [person.id],
                            operation: 'revoke',
                          })
                        }
                      >
                        {t('summarySharing.revoke')}
                      </Button>
                    )}
                </div>
                {person.read_transcript && (
                  <Text variant="note">
                    {t('summarySharing.originalAccess')}
                  </Text>
                )}
              </li>
            ))}
          </ul>
          <div className={line}>
            {cursor && (
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => setCursor(undefined)}
              >
                {t('recordAi.firstPage')}
              </Button>
            )}
            {grants.data.next_cursor && (
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => setCursor(grants.data!.next_cursor!)}
              >
                {t('library.next')}
              </Button>
            )}
          </div>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => {
              void navigator.clipboard
                .writeText(
                  `${location.origin}/meeting/records/${encodeURIComponent(recordId)}`
                )
                .then(
                  () => setMessage('summarySharing.copied'),
                  () => setMessage('summarySharing.copyError')
                )
            }}
          >
            {t('summarySharing.copyLink')}
          </Button>
        </>
      )}
      {message && <div role="status">{t(message)}</div>}
    </div>
  )
}

function Candidates({
  viewerId,
  path,
  online,
  disabled,
  onPreview,
}: {
  viewerId: string
  path: string
  online: boolean
  disabled: boolean
  onPreview: (ids: string[]) => void
}) {
  const { t } = useTranslation('meetings')
  const [scope, setScope] = useState(online ? 'participants' : 'directory')
  const [cursor, setCursor] = useState<string>()
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const query = useQuery({
    queryKey: [
      'summary-sharing-candidates',
      viewerId,
      path,
      scope,
      cursor,
      search,
    ],
    queryFn: ({ signal }) =>
      fetchApi<Page<Person>>(
        `${path}candidates/?${new URLSearchParams({ scope, q: search, ...(cursor ? { cursor } : {}) })}`,
        { signal, cache: 'no-store' }
      ),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 10000),
  })
  return (
    <div className={stack}>
      {online && (
        <label>
          {t('summarySharing.recipientSource')}{' '}
          <select
            disabled={disabled}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value)
              setCursor(undefined)
            }}
          >
            <option value="participants">
              {t('summarySharing.participants')}
            </option>
            <option value="directory">{t('summarySharing.directory')}</option>
          </select>
        </label>
      )}
      <form
        className={line}
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(text.trim())
          setCursor(undefined)
        }}
      >
        <label>
          {t('summarySharing.search')}{' '}
          <input
            disabled={disabled}
            maxLength={80}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          type="submit"
          variant="tertiary"
          isDisabled={disabled}
        >
          {t('summarySharing.search')}
        </Button>
      </form>
      {query.isError ? (
        <Text>{t('summarySharing.loadError')}</Text>
      ) : !query.data ? (
        <Text>{t('loading')}</Text>
      ) : (
        <>
          {!query.data.results.length && (
            <Text>{t('summarySharing.noCandidates')}</Text>
          )}
          <ul className={stack}>
            {query.data.results.map((person) => (
              <li key={person.id}>
                <label className={line}>
                  <input
                    type="checkbox"
                    checked={selected.includes(person.id)}
                    disabled={
                      disabled ||
                      (selected.length >= 50 && !selected.includes(person.id))
                    }
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, person.id]
                          : ids.filter((id) => id !== person.id)
                      )
                    }
                  />
                  {person.name || t('summaryNotice.unnamed')}
                </label>
              </li>
            ))}
          </ul>
          <div className={line}>
            {cursor && (
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={disabled}
                onPress={() => setCursor(undefined)}
              >
                {t('recordAi.firstPage')}
              </Button>
            )}
            {query.data.next_cursor && (
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={disabled}
                onPress={() => setCursor(query.data!.next_cursor!)}
              >
                {t('library.next')}
              </Button>
            )}
          </div>
        </>
      )}
      <Text>{t('summarySharing.selected', { count: selected.length })}</Text>
      <div className={line}>
        <Button
          size="sm"
          isDisabled={disabled || query.isError || !selected.length}
          onPress={() => onPreview(selected)}
        >
          {t('summarySharing.preview')}
        </Button>
        {selected.length > 0 && (
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={disabled}
            onPress={() => setSelected([])}
          >
            {t('summarySharing.clear')}
          </Button>
        )}
      </div>
    </div>
  )
}
