import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/ConfirmProvider'
import { Button, TextArea } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskActivity } from '../api/ApiTask'
import {
  useCreateTaskAttachment,
  useCreateTaskComment,
  useDeleteTaskAttachment,
  usePatchTask,
  useTaskActivities,
  useTaskAttachments,
  useTaskComments,
  useTaskSubtasks,
} from '../api/fetchTasks'
import { nextTaskStatuses, taskDisplayName } from '../taskUi'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskUserAvatar, TaskUserDisplay } from './TaskUserDisplay'

export const TaskSubtasksSection = ({
  taskId,
  onCreate,
}: {
  taskId: string
  onCreate: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTaskSubtasks(taskId)
  const patchMutation = usePatchTask()

  const formatDate = (value: string | null) => {
    if (!value) return t('meta.none')
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
    }).format(new Date(year, month - 1, day))
  }

  return (
    <section aria-label={t('subtasks.title')} className={sectionCss}>
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('subtasks.loading')}
        errorText={t('subtasks.error')}
        emptyText={t('subtasks.empty')}
      >
        <ul className={subtaskListCss}>
          {data?.map((subtask) => (
            <li key={subtask.id} className={subtaskItemCss}>
              <div className={inlineCss}>
                <strong>{subtask.title}</strong>
                <span className={statusBadgeCss}>
                  {t(`statuses.${subtask.status}`)}
                </span>
                <TaskPriorityBadge priority={subtask.priority} />
              </div>
              <div className={userMetaCss}>
                <TaskUserAvatar user={subtask.assignee} size="1.25rem" />
                <p className={metaCss}>
                  {t('subtasks.meta', {
                    assignee: taskDisplayName(subtask.assignee),
                    start: formatDate(subtask.start_date),
                    due: formatDate(subtask.due_date),
                  })}
                </p>
              </div>
              {subtask.can_update_status && (
                <div className={inlineCss}>
                  {nextTaskStatuses(subtask).map((status) => (
                    <Button
                      key={status}
                      variant={status === 'completed' ? 'primary' : 'secondary'}
                      size="dense"
                      isDisabled={patchMutation.isPending}
                      onPress={() =>
                        patchMutation.mutate({
                          taskId: subtask.id,
                          patch: { status },
                        })
                      }
                    >
                      {t(`actions.to_${status}`)}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </AsyncState>
      <button type="button" className={addSubtaskCss} onClick={onCreate}>
        + {t('subtasks.create')}
      </button>
    </section>
  )
}

export const TaskCommentsSection = ({
  taskId,
  readOnly = false,
}: {
  taskId: string
  readOnly?: boolean
}) => {
  const { t, i18n } = useTranslation('tasks')
  const [content, setContent] = useState('')
  const { data, isLoading, error } = useTaskComments(taskId)
  const createMutation = useCreateTaskComment()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!content.trim()) return
    try {
      await createMutation.mutateAsync({ taskId, content: content.trim() })
      setContent('')
    } catch {
      // Keep the draft available for retry.
    }
  }

  return (
    <section aria-label={t('comments.title')} className={sectionCss}>
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('comments.loading')}
        errorText={t('comments.error')}
        emptyText={t('comments.empty')}
      >
        <ul className={listCss}>
          {data?.map((comment) => (
            <li key={comment.id} className={itemCss}>
              <div className={betweenCss}>
                <strong>
                  <TaskUserDisplay user={comment.author} />
                </strong>
                <time className={metaCss} dateTime={comment.created_at}>
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(comment.created_at))}
                </time>
              </div>
              <p className={bodyCss}>{comment.content}</p>
            </li>
          ))}
        </ul>
      </AsyncState>
      {!readOnly && (
        <form onSubmit={(event) => void submit(event)} className={stackCss}>
          <label className={fieldCss}>
            {t('comments.inputLabel')}
            <TextArea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t('comments.placeholder')}
              maxLength={2000}
              rows={3}
            />
          </label>
          {createMutation.error && (
            <p role="alert" className={errorCss}>
              {t('comments.postError')}
            </p>
          )}
          <Button
            type="submit"
            size="dense"
            loading={createMutation.isPending}
            isDisabled={!content.trim()}
          >
            {t('comments.submit')}
          </Button>
        </form>
      )}
    </section>
  )
}

export const TaskAttachmentsSection = ({
  taskId,
  readOnly = false,
}: {
  taskId: string
  readOnly?: boolean
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { confirm } = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState(0)
  const { data, isLoading, error } = useTaskAttachments(taskId)
  const createMutation = useCreateTaskAttachment()
  const deleteMutation = useDeleteTaskAttachment()

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setProgress(0)
    try {
      await createMutation.mutateAsync({
        taskId,
        file,
        onProgress: setProgress,
      })
    } catch {
      // Mutation error is shown below.
    }
  }

  const remove = async (attachmentId: string) => {
    if (
      !(await confirm({
        message: t('attachments.removeConfirm'),
        danger: true,
      }))
    )
      return
    await deleteMutation.mutateAsync({ taskId, attachmentId }).catch(() => {})
  }

  const formatSize = (size: number | null) => {
    if (size === null) return t('attachments.unknownSize')
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <section aria-label={t('attachments.title')} className={sectionCss}>
      <input
        ref={inputRef}
        type="file"
        className={css({ display: 'none' })}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpeg,.jpg,.png,.gif,.webp,.zip"
        onChange={(event) => void selectFile(event)}
      />
      {!readOnly && (
        <Button
          variant="secondary"
          size="sm"
          isDisabled={createMutation.isPending}
          onPress={() => inputRef.current?.click()}
        >
          {createMutation.isPending
            ? t('attachments.uploading', { progress })
            : t('attachments.upload')}
        </Button>
      )}
      {(createMutation.error || deleteMutation.error) && (
        <p role="alert" className={errorCss}>
          {createMutation.error
            ? t('attachments.uploadError')
            : t('attachments.removeError')}
        </p>
      )}
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('attachments.loading')}
        errorText={t('attachments.error')}
        emptyText={t('attachments.empty')}
      >
        <ul className={listCss}>
          {data?.map((attachment) => (
            <li key={attachment.id} className={itemCss}>
              <strong className={css({ overflowWrap: 'anywhere' })}>
                {attachment.filename}
              </strong>
              <div className={userMetaCss}>
                <TaskUserAvatar user={attachment.uploader} size="1.25rem" />
                <p className={metaCss}>
                  {t('attachments.meta', {
                    name: taskDisplayName(attachment.uploader),
                    size: formatSize(attachment.size),
                    date: new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(attachment.created_at)),
                  })}
                </p>
              </div>
              <div className={inlineCss}>
                <a
                  href={attachment.url}
                  target="_blank"
                  rel="noreferrer"
                  className={linkCss}
                >
                  {t('attachments.open')}
                </a>
                {!readOnly && (
                  <Button
                    variant="danger"
                    size="dense"
                    isDisabled={deleteMutation.isPending}
                    onPress={() => void remove(attachment.id)}
                  >
                    {t('attachments.remove')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </AsyncState>
    </section>
  )
}

export const TaskHistorySection = ({ taskId }: { taskId: string }) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTaskActivities(taskId)
  return (
    <section aria-label={t('history.title')} className={sectionCss}>
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('history.loading')}
        errorText={t('history.error')}
        emptyText={t('history.empty')}
      >
        <ol className={timelineCss}>
          {data?.map((activity) => (
            <li key={activity.id} className={timelineItemCss}>
              <div className={userMetaCss}>
                <TaskUserAvatar user={activity.actor} size="1.25rem" />
                <p className={bodyCss}>{taskActivityMessage(activity, t)}</p>
              </div>
              <time className={metaCss} dateTime={activity.created_at}>
                {new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(activity.created_at))}
              </time>
            </li>
          ))}
        </ol>
      </AsyncState>
    </section>
  )
}

const taskActivityMessage = (
  activity: ApiTaskActivity,
  t: TFunction<'tasks'>
) => {
  const actor = taskDisplayName(activity.actor)
  if (activity.event === 'status_changed') {
    const status = activity.changes.status?.to
    const event = activity.changes.source_action_item_origin
      ? 'history.events.status_changed_from_action_item'
      : 'history.events.status_changed'
    const base = t(event, {
      actor,
      status: status ? t(`statuses.${status}`) : '—',
    })
    const sync = activity.changes.source_action_item_sync
    if (!sync) return base
    const sourceStatus = t(`actionItemStatuses.${sync.to}`)
    if (sync.result === 'updated')
      return t('history.events.status_changed_synced', { base, sourceStatus })
    if (sync.result === 'already_aligned')
      return t('history.events.status_changed_aligned', { base, sourceStatus })
    return t('history.events.status_changed_conflict', { base, sourceStatus })
  }
  if (activity.event === 'priority_changed') {
    const priority = activity.changes.priority
    return t('history.events.priority_changed', {
      actor,
      from: priority ? t(`priorities.${priority.from}`) : '—',
      to: priority ? t(`priorities.${priority.to}`) : '—',
    })
  }
  if (activity.event === 'placement_changed') {
    const placement = activity.changes.placement
    const from = placement?.from.task_list
      ? `${placement.from.task_list.name}${placement.from.group ? ` / ${placement.from.group.name}` : ''}`
      : t('taskLists.none')
    const to = placement?.to.task_list
      ? `${placement.to.task_list.name}${placement.to.group ? ` / ${placement.to.group.name}` : ''}`
      : t('taskLists.none')
    return t('history.events.placement_changed', { actor, from, to })
  }
  if (activity.event === 'assignee_changed') {
    const assignee = activity.changes.assignee
    const target = assignee && 'to' in assignee ? assignee.to?.name : null
    return t('history.events.assignee_changed', {
      actor,
      assignee: target || '—',
    })
  }
  if (activity.event === 'attachment_removed') {
    return t('history.events.attachment_removed', {
      actor,
      filename: activity.changes.attachment?.filename || '—',
    })
  }
  if (activity.event === 'source_action_item_changed') {
    const source = activity.changes.source_action_item
    const status = source?.status.to
    const event = source?.overrode_task_sync
      ? 'history.events.source_action_item_overrode'
      : 'history.events.source_action_item_changed'
    const base = t(event, {
      actor,
      status: status ? t(`actionItemStatuses.${status}`) : '—',
    })
    const sync = activity.changes.linked_task_sync
    if (!sync) return base
    const taskStatus = t(`statuses.${sync.to}`)
    if (sync.result === 'updated')
      return t('history.events.source_action_item_synced_task', {
        base,
        taskStatus,
      })
    if (sync.result === 'already_aligned')
      return t('history.events.source_action_item_task_aligned', {
        base,
        taskStatus,
      })
    return t('history.events.source_action_item_task_conflict', {
      base,
      taskStatus,
    })
  }
  return t(`history.events.${activity.event}`, { actor })
}

const AsyncState = ({
  loading,
  error,
  empty,
  loadingText,
  errorText,
  emptyText,
  children,
}: {
  loading: boolean
  error: boolean
  empty: boolean
  loadingText: string
  errorText: string
  emptyText: string
  children: ReactNode
}) => {
  if (loading) return <p className={hintCss}>{loadingText}</p>
  if (error) return <p className={errorCss}>{errorText}</p>
  if (empty) return <p className={hintCss}>{emptyText}</p>
  return children
}

const sectionCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
})
const stackCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})
const addSubtaskCss = css({
  alignSelf: 'flex-start',
  border: 0,
  backgroundColor: 'transparent',
  color: 'primary.600',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  _dark: { color: 'primaryDark.700' },
})
const fieldCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  color: 'default.text',
  fontSize: '0.875rem',
})
const listCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
})
const subtaskListCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
})
const subtaskItemCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.625rem 0.25rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  color: 'default.text',
  fontSize: '0.8125rem',
  _first: { paddingTop: '0.25rem' },
})
const itemCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.50',
  color: 'default.text',
})
const inlineCss = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.5rem',
})
const betweenCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
})
const userMetaCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  '& > p': { minWidth: 0 },
})
const statusBadgeCss = css({
  borderRadius: '999px',
  paddingX: '0.5rem',
  paddingY: '0.125rem',
  backgroundColor: 'primary.50',
  color: 'primary.700',
  fontSize: '0.75rem',
  fontWeight: '600',
})
const metaCss = css({
  margin: 0,
  color: 'default.subtle-text',
  fontSize: '0.75rem',
})
const bodyCss = css({
  margin: 0,
  color: 'default.text',
  fontSize: '0.875rem',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
const hintCss = css({ margin: 0, color: 'default.subtle-text' })
const errorCss = css({ margin: 0, color: 'danger.subtle-text' })
const linkCss = css({ color: 'primary.600', textDecoration: 'none' })
const timelineCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})
const timelineItemCss = css({
  position: 'relative',
  paddingLeft: '1rem',
  borderLeft: '1px solid token(colors.greyscale.300)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  _before: {
    content: '""',
    position: 'absolute',
    left: '-0.25rem',
    top: '0.25rem',
    width: '0.4375rem',
    height: '0.4375rem',
    borderRadius: '999px',
    backgroundColor: 'primary.500',
  },
})
