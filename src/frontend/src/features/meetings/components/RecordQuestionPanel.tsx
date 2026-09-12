import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, H, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import type {
  ApiRecordSummaryVersion,
  RecordSourceReference,
} from '../api/ApiMeetingRecord'

type Question = {
  id: string
  snapshot_id: string
  status: 'running' | 'succeeded' | 'failed' | 'incomplete' | 'canceled'
  question: string
  content: {
    answerable: boolean
    answer: string
    source_refs: RecordSourceReference[]
  } | null
  error_code: string
}
type Intent = { key: string; snapshot_id: string; question: string }
const stack = css({ display: 'flex', flexDirection: 'column', gap: '0.75rem' })
const field = css({
  width: '100%',
  padding: '0.5rem',
  border: '1px solid',
  borderColor: 'greyscale.300',
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
})

export const RecordQuestionPanel = ({
  recordId,
  viewerId,
  versions,
  onSource,
}: {
  recordId: string
  viewerId: string
  versions: ApiRecordSummaryVersion[]
  onSource: (snapshotId: string, ref: RecordSourceReference) => void
}) => {
  const { t } = useTranslation('meetings')
  const path = `meeting-records/${encodeURIComponent(recordId)}/questions/`
  const availability = useQuery({
    queryKey: ['record-question-availability', viewerId, path],
    queryFn: ({ signal }) =>
      fetchApi<{ available: boolean; recent?: Question[] }>(path, { signal }),
    retry: false,
    gcTime: 0,
  })
  const [snapshot, setSnapshot] = useState('')
  const [selectedSource, setSelectedSource] =
    useState<ApiRecordSummaryVersion>()
  const [question, setQuestion] = useState('')
  const [intent, setIntent] = useState<Intent>()
  const [response, setResponse] = useState<Question>()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const current = useQuery({
    queryKey: ['record-question', viewerId, path, response?.id],
    queryFn: ({ signal }) =>
      fetchApi<Question>(`${path}${response!.id}/`, { signal }),
    enabled: !!response,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.error
        ? false
        : (query.state.data?.status ?? response?.status) === 'running'
          ? 2000
          : false,
  })
  const answer = current.data ?? response
  const busy = saving || !!intent || answer?.status === 'running'
  const sources = [
    ...new Map(
      [...versions, ...(selectedSource ? [selectedSource] : [])].map(
        (version) => [version.input_snapshot_id, version]
      )
    ).values(),
  ]
  const ask = async () => {
    if (
      inFlight.current ||
      answer?.status === 'running' ||
      !availability.data?.available
    )
      return
    const payload = intent ?? {
      key: crypto.randomUUID(),
      snapshot_id: snapshot,
      question: question.trim(),
    }
    if (!payload.question || !payload.snapshot_id) return
    inFlight.current = true
    setSaving(true)
    setIntent(payload)
    setResponse(undefined)
    setMessage('')
    try {
      const result = await fetchApi<Question>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setResponse(result)
      setIntent(undefined)
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      ) {
        setIntent(undefined)
        setMessage(
          error.statusCode === 409
            ? 'recordQuestion.conflict'
            : 'recordQuestion.denied'
        )
      } else setMessage('recordQuestion.uncertain')
    } finally {
      setSaving(false)
      inFlight.current = false
    }
  }
  if (availability.isError || current.isError)
    return (
      <div className={stack}>
        <Text>{t('recordQuestion.unavailable')}</Text>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() =>
            void Promise.allSettled([
              availability.refetch(),
              ...(response ? [current.refetch()] : []),
            ])
          }
        >
          {t('recordAi.refresh')}
        </Button>
      </div>
    )
  if (
    !availability.data?.available &&
    !response &&
    !availability.data?.recent?.length
  )
    return null
  return (
    <section className={stack} aria-label={t('recordQuestion.title')}>
      <H lvl={3}>{t('recordQuestion.title')}</H>
      <Text variant="note">{t('recordQuestion.scope')}</Text>
      {!!availability.data?.recent?.length && (
        <details>
          <summary>{t('recordQuestion.recent')}</summary>
          <div className={stack}>
            {availability.data.recent.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="tertiary"
                isDisabled={busy}
                onPress={() => {
                  setResponse(item)
                  setQuestion(item.question)
                  setSnapshot(item.snapshot_id)
                  setMessage('')
                }}
              >
                {item.question} · {t(`recordQuestion.status.${item.status}`)}
              </Button>
            ))}
          </div>
        </details>
      )}
      <label>
        {t('recordQuestion.source')}
        <select
          className={field}
          value={snapshot}
          disabled={busy}
          onChange={(event) => {
            setSnapshot(event.target.value)
            setSelectedSource(
              sources.find(
                (source) => source.input_snapshot_id === event.target.value
              )
            )
            setResponse(undefined)
          }}
        >
          <option value="">{t('recordQuestion.choose')}</option>
          {snapshot &&
            !sources.some(
              (source) => source.input_snapshot_id === snapshot
            ) && (
              <option value={snapshot}>
                {t('recordQuestion.historySource')}
              </option>
            )}
          {sources.map((version) => (
            <option
              key={version.input_snapshot_id}
              value={version.input_snapshot_id}
            >
              {t(`recordAi.stage.${version.stage}`)} ·{' '}
              {new Date(version.created_at).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('recordQuestion.question')}
        <textarea
          className={field}
          rows={3}
          maxLength={2000}
          value={question}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      <Button
        size="sm"
        isDisabled={
          saving ||
          answer?.status === 'running' ||
          !availability.data?.available ||
          (!intent && (!snapshot || !question.trim()))
        }
        onPress={() => void ask()}
      >
        {t(intent ? 'recordQuestion.retry' : 'recordQuestion.ask')}
      </Button>
      {saving && <div role="status">{t('recordQuestion.status.running')}</div>}
      {message && <div role="status">{t(message)}</div>}
      {answer && (
        <article className={stack}>
          <Text>{answer.question}</Text>
          <div role="status">{t(`recordQuestion.status.${answer.status}`)}</div>
          {answer.status === 'succeeded' && answer.content && (
            <>
              <Text>
                {answer.content.answerable
                  ? answer.content.answer
                  : t('recordQuestion.noEvidence')}
              </Text>
              {answer.content.source_refs.map((ref, i) => (
                <Button
                  size="sm"
                  variant="tertiary"
                  key={i}
                  onPress={() => onSource(answer.snapshot_id, ref)}
                >
                  {t('recordAi.source')} {Math.floor(ref.start_ms / 1000)}s
                </Button>
              ))}
            </>
          )}
          {['failed', 'incomplete'].includes(answer.status) && (
            <Text variant="note">{t('recordQuestion.newAttempt')}</Text>
          )}
        </article>
      )}
    </section>
  )
}
