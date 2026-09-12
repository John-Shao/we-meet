import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import type { ApiRecordSummaryVersion } from '../api/ApiMeetingRecord'

type TaskLink = {
  task_id: string | null
  status: string | null
  deleted: boolean
}
type State = {
  can_convert: boolean
  review_id: string | null
  assignees: { id: string; name: string }[]
  actions: (TaskLink | null)[]
}
type Intent = {
  key: string
  review_id: string
  action_index: number
  title: string
  assignee_id: string
  due_date: string | null
}
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

export const SummaryTaskActions = ({
  recordId,
  viewerId,
  reviewId,
  actions,
}: {
  recordId: string
  viewerId: string
  reviewId: string
  actions: ApiRecordSummaryVersion['content']['action_items']
}) => {
  const { t } = useTranslation('meetings')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const path = `meeting-records/${encodeURIComponent(recordId)}/summary-tasks/`
  const query = useQuery({
    queryKey: ['summary-tasks', viewerId, reviewId, path, search],
    queryFn: ({ signal }) =>
      fetchApi<State>(`${path}?q=${encodeURIComponent(search)}`, { signal }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })
  const [editing, setEditing] = useState<number>()
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')
  const [intent, setIntent] = useState<Intent>()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const save = async () => {
    if (inFlight.current || editing === undefined || !query.data?.can_convert)
      return
    const payload = intent ?? {
      key: crypto.randomUUID(),
      review_id: reviewId,
      action_index: editing,
      title,
      assignee_id: assignee,
      due_date: due || null,
    }
    setIntent(payload)
    setSaving(true)
    inFlight.current = true
    setMessage('')
    try {
      const result = await fetchApi<{ created: boolean }>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setIntent(undefined)
      setEditing(undefined)
      setMessage(
        result.created ? 'summaryTasks.created' : 'summaryTasks.reused'
      )
      await query.refetch()
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      ) {
        setIntent(undefined)
        setMessage(
          error.statusCode === 409
            ? 'summaryTasks.conflict'
            : 'summaryTasks.denied'
        )
      } else setMessage('summaryTasks.uncertain')
    } finally {
      setSaving(false)
      inFlight.current = false
    }
  }
  if (query.isError) return <Text>{t('summaryTasks.unavailable')}</Text>
  if (!query.data) return null
  if (query.data.review_id !== reviewId)
    return <Text>{t('summaryTasks.conflict')}</Text>
  if (!query.data.can_convert && !query.data.actions.some(Boolean)) return null
  const disabled = saving || !!intent
  return (
    <section className={stack} aria-label={t('summaryTasks.title')}>
      <h4>{t('summaryTasks.title')}</h4>
      <Text variant="note">{t('summaryTasks.explanation')}</Text>
      {actions.map((point, index) => {
        const link = query.data.actions[index]
        return (
          <div className={stack} key={index}>
            <Text>{point.text}</Text>
            {link && (
              <>
                <Text>
                  {t(
                    link.deleted
                      ? 'summaryTasks.deleted'
                      : 'summaryTasks.converted'
                  )}
                  {link.status
                    ? ` · ${t(`summaryTasks.status.${link.status}`)}`
                    : ''}
                </Text>
                {link.task_id && (
                  <a
                    href={`/tasks?task=${encodeURIComponent(link.task_id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('summaryTasks.open')}
                  </a>
                )}
              </>
            )}
            {query.data.can_convert && !link && editing === undefined && (
              <Button
                size="sm"
                onPress={() => {
                  setEditing(index)
                  setTitle(point.text)
                  setAssignee('')
                  setDue('')
                  setMessage('')
                }}
              >
                {t('summaryTasks.convert')}
              </Button>
            )}
            {editing === index && (
              <>
                <label>
                  {t('summaryTasks.taskTitle')}
                  <textarea
                    className={field}
                    maxLength={4000}
                    disabled={disabled}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <Text variant="note">
                  {t('summaryTasks.hints', {
                    owner: point.owner_text || '—',
                    due: point.due_text || '—',
                  })}
                </Text>
                <label>
                  {t('summaryTasks.search')}
                  <input
                    className={field}
                    value={searchInput}
                    disabled={disabled}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={disabled}
                  onPress={() => {
                    setSearch(searchInput.trim())
                    setAssignee('')
                  }}
                >
                  {t('summaryTasks.find')}
                </Button>
                <label>
                  {t('summaryTasks.assignee')}
                  <select
                    className={field}
                    value={assignee}
                    disabled={disabled}
                    onChange={(event) => setAssignee(event.target.value)}
                  >
                    <option value="">{t('summaryTasks.choose')}</option>
                    {query.data.assignees.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('summaryTasks.due')}
                  <input
                    className={field}
                    type="date"
                    value={due}
                    disabled={disabled}
                    onChange={(event) => setDue(event.target.value)}
                  />
                </label>
                <Text variant="note">{t('summaryTasks.shareNotice')}</Text>
                <Button
                  size="sm"
                  isDisabled={
                    saving ||
                    !query.data.can_convert ||
                    (!intent && (!title.trim() || !assignee))
                  }
                  onPress={() => void save()}
                >
                  {t(intent ? 'summaryTasks.retry' : 'summaryTasks.confirm')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={disabled}
                  onPress={() => setEditing(undefined)}
                >
                  {t('summaryTasks.cancel')}
                </Button>
              </>
            )}
          </div>
        )
      })}
      {message && <div role="status">{t(message)}</div>}
    </section>
  )
}
