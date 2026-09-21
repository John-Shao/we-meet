import { readRecovery } from '../hooks/readRecovery'
import { formatDateTime } from '../recordDateTime'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { receiptRole, statusRole } from './liveRegionRole'

type Props = { recordId: string; viewerId: string; summaryId?: string }
type Notice = {
  id: string
  summary_id: string
  status:
    | 'queued'
    | 'running'
    | 'delivered'
    | 'uncertain'
    | 'failed'
    | 'unavailable'
    | 'canceled'
  attempt: number
  error_code: string
  created_at: string
}
type Results = {
  available: boolean
  strategy: 'owner' | 'owners_and_initiators'
  legacy_delivery_unchanged: boolean
  future_recipients?: { id: string; name: string }[]
  policy_error?: string
  results: Notice[]
}
type Intent = { key: string; expected_attempt: number }
const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  minWidth: 0,
  overflowWrap: 'anywhere',
})
function loadIntent(key: string): Intent | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null'
    ) as Intent | null
    if (
      value &&
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.key) &&
      Number.isInteger(value.expected_attempt) &&
      value.expected_attempt >= 1 &&
      value.expected_attempt < 20
    )
      return value
  } catch {
    /* Recovery markers contain no message content or credentials. */
  }
}

export const SummaryNotificationPanel = (props: Props) => (
  <Panel
    key={`${props.viewerId}:${props.recordId}:${props.summaryId ?? 'all'}`}
    {...props}
  />
)

function Panel({ recordId, viewerId, summaryId }: Props) {
  const { t } = useTranslation('meetings')
  const [opened, setOpened] = useState(false)
  const path = `meeting-records/${encodeURIComponent(recordId)}/summary-notifications/`
  const query = useQuery({
    queryKey: ['summary-notifications', viewerId, recordId, summaryId, path],
    queryFn: ({ signal }) =>
      fetchApi<Results>(
        `${path}${summaryId === undefined ? '' : `?${new URLSearchParams({ summary_id: summaryId })}`}`,
        { signal, cache: 'no-store' }
      ),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 5000),
  })
  if (query.isError)
    return (
      <div className={stack}>
        <Text>{t('summaryNotice.loadError')}</Text>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => void query.refetch()}
        >
          {t('recordAi.refresh')}
        </Button>
      </div>
    )
  if (!query.data?.available && !query.data?.results?.length) return null
  const data = query.data!
  return (
    <section className={stack} aria-label={t('summaryNotice.title')}>
      <Button size="sm" variant="tertiary" onPress={() => setOpened(!opened)}>
        {t(opened ? 'summaryNotice.close' : 'summaryNotice.title')}
      </Button>
      {opened && (
        <>
          <Text>{t(`summaryNotice.strategy.${data.strategy}`)}</Text>
          <Text variant="note">{t('summaryNotice.permissionHint')}</Text>
          {!data.available && <Text>{t('summaryNotice.paused')}</Text>}
          {data.legacy_delivery_unchanged && (
            <Text variant="note">{t('summaryNotice.legacy')}</Text>
          )}
          {data.future_recipients && (
            <div>
              <Text>{t('summaryNotice.futureRecipients')}</Text>
              {data.policy_error ? (
                <Text>{t('summaryNotice.policyError')}</Text>
              ) : data.future_recipients.length ? (
                <ul>
                  {data.future_recipients.map((user) => (
                    <li key={user.id}>
                      {user.name || t('summaryNotice.unnamed')}
                    </li>
                  ))}
                </ul>
              ) : (
                <Text>{t('summaryNotice.noRecipients')}</Text>
              )}
            </div>
          )}
          <Text>{t('summaryNotice.mine')}</Text>
          {!data.results.length && <Text>{t('summaryNotice.empty')}</Text>}
          {data.results.map((notice) => (
            <Delivery
              key={notice.id}
              notice={notice}
              available={data.available}
              viewerId={viewerId}
              recordId={recordId}
              path={path}
              refresh={() => void query.refetch()}
            />
          ))}
        </>
      )}
    </section>
  )
}

function Delivery({
  notice,
  available,
  viewerId,
  recordId,
  path,
  refresh,
}: {
  notice: Notice
  available: boolean
  viewerId: string
  recordId: string
  path: string
  refresh: () => void
}) {
  const { t } = useTranslation('meetings')
  const storageKey = `meeting-summary-notice:${viewerId}:${recordId}:${notice.id}`
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
  const submit = async () => {
    if (recovery.blocked) return
    if (inFlight.current) return
    const request = intent ?? {
      key: crypto.randomUUID(),
      expected_attempt: notice.attempt,
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request))
    } catch {
      setMessage('summaryNotice.storageUnavailable')
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
    }
    try {
      await fetchApi(`${path}${encodeURIComponent(notice.id)}/retry/`, {
        method: 'POST',
        signal,
        headers: { 'Idempotency-Key': request.key },
        meetingCommand: { key: request.key, scope: { record_id: recordId } },
        body: JSON.stringify({ expected_attempt: request.expected_attempt }),
      })
      if (signal.aborted) return
      clear()
      setMessage('summaryNotice.accepted')
    } catch (error) {
      if (signal.aborted) return
      if (
        error instanceof ApiError &&
        [400, 409, 422].includes(error.statusCode)
      ) {
        clear()
        setMessage(
          error.statusCode === 409
            ? 'summaryNotice.conflict'
            : 'summaryNotice.loadError'
        )
      } else setMessage('summaryNotice.uncertainRequest')
    } finally {
      inFlight.current = false
      if (!signal.aborted) {
        setBusy(false)
        refresh()
      }
    }
  }
  if (recovery.blocked)
    return <Text>{t('summaryNotice.storageUnavailable')}</Text>
  const retryable =
    available &&
    ['failed', 'uncertain', 'canceled'].includes(notice.status) &&
    notice.attempt < 20 &&
    notice.error_code !== 'message_conflict'
  return (
    <article
      className={css({
        border: '1px solid',
        borderColor: 'border.subtle',
        borderRadius: 'control',
        padding: 'md',
      })}
    >
      <div className={stack}>
        <div role={statusRole(notice.status)}>
          {formatDateTime(notice.created_at)} ·{' '}
          {t(`summaryNotice.status.${notice.status}`)}
        </div>
        <Link
          href={`/meeting/records/${encodeURIComponent(recordId)}?${new URLSearchParams({ summary: notice.summary_id })}`}
        >
          {t('summaryNotice.openVersion')}
        </Link>
        {notice.status === 'uncertain' && (
          <Text variant="note">{t('summaryNotice.recoveryHint')}</Text>
        )}
        {notice.error_code === 'message_conflict' && (
          <Text>{t('summaryNotice.deliveryConflict')}</Text>
        )}
        {(intent || retryable) && (
          <>
            <Text variant="note">
              {t(
                intent ? 'summaryNotice.pendingHint' : 'summaryNotice.retryHint'
              )}
            </Text>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={busy}
              onPress={() => void submit()}
            >
              {t(intent ? 'summaryNotice.resubmit' : 'summaryNotice.retry')}
            </Button>
          </>
        )}
        {message && <div role={receiptRole(message)}>{t(message)}</div>}
      </div>
    </article>
  )
}
