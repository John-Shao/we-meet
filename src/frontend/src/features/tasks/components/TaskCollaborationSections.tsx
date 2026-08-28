import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { RiDeleteBinLine, RiDownloadLine } from '@remixicon/react'

import { useConfirm } from '@/components/ConfirmProvider'
import { Button, TextArea } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskActivity } from '../api/ApiTask'
import {
  useCreateTaskAttachment,
  useCreateTaskComment,
  useDeleteTaskAttachment,
  useTaskActivities,
  useTaskAttachments,
  useTaskComments,
} from '../api/fetchTasks'
import { taskDisplayName } from '../taskUi'
import {
  TaskAttachmentListSkeleton,
  TaskCommentListSkeleton,
  TaskHistoryListSkeleton,
} from './TaskSkeletons'
import { TaskUserAvatar, TaskUserDisplay } from './TaskUserDisplay'

export const TaskCommentsSection = ({
  taskId,
  sharedVia,
  readOnly = false,
}: {
  taskId: string
  sharedVia?: string
  readOnly?: boolean
}) => {
  const { t, i18n } = useTranslation('tasks')
  const [content, setContent] = useState('')
  const { data, isLoading, error } = useTaskComments(taskId, sharedVia)
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
        loadingContent={
          <TaskCommentListSkeleton label={t('comments.loading')} />
        }
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
  sharedVia,
  readOnly = false,
}: {
  taskId: string
  sharedVia?: string
  readOnly?: boolean
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { confirm } = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState(0)
  const { data, isLoading, error } = useTaskAttachments(taskId, sharedVia)
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
    <section
      aria-label={t('attachments.title')}
      className={attachmentSectionCss}
    >
      <input
        ref={inputRef}
        type="file"
        className={css({ display: 'none' })}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpeg,.jpg,.png,.gif,.webp,.zip"
        onChange={(event) => void selectFile(event)}
      />
      {!readOnly && (
        <Button
          variant="quaternaryText"
          size="dense"
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
        loadingContent={
          <TaskAttachmentListSkeleton label={t('attachments.loading')} />
        }
        errorText={t('attachments.error')}
        emptyText={t('attachments.empty')}
      >
        <ul className={attachmentListCss}>
          {data?.map((attachment) => (
            <li key={attachment.id} className={attachmentItemCss}>
              <div className={attachmentInfoCss}>
                <span className={attachmentNameCss}>{attachment.filename}</span>
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
              </div>
              <div className={attachmentActionsCss} data-attachment-actions>
                <a
                  href={attachment.url}
                  download={attachment.filename}
                  className={attachmentActionCss}
                  aria-label={t('attachments.download')}
                  title={t('attachments.download')}
                >
                  <RiDownloadLine size={17} aria-hidden="true" />
                </a>
                {!readOnly && (
                  <button
                    type="button"
                    className={attachmentDeleteActionCss}
                    aria-label={t('attachments.remove')}
                    title={t('attachments.remove')}
                    disabled={deleteMutation.isPending}
                    onClick={() => void remove(attachment.id)}
                  >
                    <RiDeleteBinLine size={17} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </AsyncState>
    </section>
  )
}

export const TaskHistorySection = ({
  taskId,
  sharedVia,
}: {
  taskId: string
  sharedVia?: string
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTaskActivities(taskId, sharedVia)
  return (
    <section aria-label={t('history.title')} className={sectionCss}>
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('history.loading')}
        loadingContent={
          <TaskHistoryListSkeleton label={t('history.loading')} />
        }
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
      : t('taskLists.standalone')
    const to = placement?.to.task_list
      ? `${placement.to.task_list.name}${placement.to.group ? ` / ${placement.to.group.name}` : ''}`
      : t('taskLists.standalone')
    return t('history.events.placement_changed', { actor, from, to })
  }
  if (activity.event === 'hierarchy_changed') {
    const parent = activity.changes.parent
    return t('history.events.hierarchy_changed', {
      actor,
      from: parent?.from?.title || t('subtasks.rootTask'),
      to: parent?.to?.title || t('subtasks.rootTask'),
    })
  }
  if (activity.event === 'assignee_changed') {
    const assignees = activity.changes.assignees
    const targets =
      assignees && !Array.isArray(assignees) && 'to' in assignees
        ? assignees.to.map((assignee) => assignee.name).join('、')
        : null
    const assignee = activity.changes.assignee
    const target = assignee && 'to' in assignee ? assignee.to?.name : null
    return t('history.events.assignee_changed', {
      actor,
      assignee: targets || target || '—',
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
  loadingContent,
  errorText,
  emptyText,
  children,
}: {
  loading: boolean
  error: boolean
  empty: boolean
  loadingText: string
  loadingContent?: ReactNode
  errorText: string
  emptyText: string
  children: ReactNode
}) => {
  if (loading) return loadingContent || <p className={hintCss}>{loadingText}</p>
  if (error) return <p className={errorCss}>{errorText}</p>
  if (empty) return <p className={hintCss}>{emptyText}</p>
  return children
}

const sectionCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
})
const attachmentSectionCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
})
const stackCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
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
const attachmentListCss = css({
  width: '100%',
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
})
const attachmentItemCss = css({
  width: '100%',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.50',
  color: 'default.text',
  transition: 'border-color 120ms ease, background-color 120ms ease',
  _hover: {
    borderColor: 'greyscale.300',
    backgroundColor: 'greyscale.000',
    '& [data-attachment-actions]': {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
  _focusWithin: {
    borderColor: 'primary.400',
    backgroundColor: 'greyscale.000',
    '& [data-attachment-actions]': {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
})
const attachmentInfoCss = css({
  minWidth: 0,
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  gap: '0.25rem',
})
const attachmentNameCss = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '0.8125rem',
  fontWeight: '400',
})
const attachmentActionsCss = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms ease',
  '@media (hover: none)': {
    opacity: 1,
    pointerEvents: 'auto',
  },
})
const attachmentActionCss = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100', color: 'greyscale.900' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.400)',
    outlineOffset: '1px',
  },
})
const attachmentDeleteActionCss = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'danger.50', color: 'danger.600' },
  _focusVisible: {
    outline: '2px solid token(colors.danger.400)',
    outlineOffset: '1px',
  },
  _disabled: { cursor: 'not-allowed', opacity: 0.45 },
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
