import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'wouter'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { StateHint } from '@/components/StateHint'
import { RequireAuth } from '@/components/RequireAuth'
import { ContactPicker, type DirectoryMember } from '@/features/contacts'
import { Screen } from '@/layout/Screen'
import { Button, Input, TextArea } from '@/primitives'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskActivity,
  PatchTaskPayload,
  TaskScope,
  TaskStatus,
} from '../api/ApiTask'
import {
  useCreateTaskComment,
  useCreateTaskAttachment,
  useCreateTask,
  useCreateTaskSubtask,
  usePatchTask,
  useTaskActivities,
  useTaskAttachments,
  useTaskComments,
  useTaskSubtasks,
  useTasks,
} from '../api/fetchTasks'

const scopes: TaskScope[] = ['assigned', 'created', 'all']

const nextStatusActions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'completed', 'canceled'],
  in_progress: ['todo', 'completed', 'canceled'],
  completed: ['todo'],
  canceled: ['todo'],
}

const labelCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  // Match the shared Field primitive: editable field labels use the normal
  // foreground color and 14px type. Muted text is reserved for descriptions,
  // metadata and genuinely disabled controls.
  fontSize: '0.875rem',
  color: 'default.text',
})

// The creation form sits on a subtle panel. Give editable controls their own
// surface so they do not visually blend into the panel and look disabled.
// Semantic tokens keep the same distinction when the dark theme is active.
const editableControlCss = css({
  backgroundColor: 'default.bg',
  _placeholder: {
    color: 'default.subtle-text',
    opacity: 1,
  },
})

const displayName = (user: ApiTask['creator'] | null) =>
  user?.full_name || user?.short_name || user?.email || '—'

const taskUserFromMember = (member: DirectoryMember) => ({
  id: member.id,
  full_name: member.full_name,
  short_name: member.short_name,
  email: member.email,
})

export const TasksRoute = () => (
  <RequireAuth>
    <Screen footer={false}>
      <TasksAuthenticated />
    </Screen>
  </RequireAuth>
)

const TasksAuthenticated = () => {
  const { t, i18n } = useTranslation('tasks')
  const [scope, setScope] = useState<TaskScope>('assigned')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [createAssignee, setCreateAssignee] = useState<DirectoryMember | null>(
    null
  )
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [editing, setEditing] = useState<ApiTask | null>(null)
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(
    () => new Set()
  )
  const [expandedComments, setExpandedComments] = useState<Set<string>>(
    () => new Set()
  )
  const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(
    () => new Set()
  )
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<string>>(
    () => new Set()
  )
  const [assigneePicker, setAssigneePicker] = useState<
    'create' | 'edit' | null
  >(null)
  const { data, isLoading, error } = useTasks(scope)
  const createMutation = useCreateTask()
  const patchMutation = usePatchTask()

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (!cleanTitle) return
    try {
      await createMutation.mutateAsync({
        title: cleanTitle,
        description: description.trim(),
        assignee_id: createAssignee?.id,
        start_date: startDate || null,
        due_date: dueDate || null,
      })
      setTitle('')
      setDescription('')
      setCreateAssignee(null)
      setStartDate('')
      setDueDate('')
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  const patchStatus = (task: ApiTask, status: TaskStatus) =>
    patchMutation.mutate({ taskId: task.id, patch: { status } })

  const toggleActivities = (taskId: string) => {
    setExpandedActivities((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleAttachments = (taskId: string) => {
    setExpandedAttachments((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleComments = (taskId: string) => {
    setExpandedComments((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleSubtasks = (taskId: string) => {
    setExpandedSubtasks((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editing || !editing.title.trim()) return
    const patch: PatchTaskPayload = {
      title: editing.title.trim(),
      description: editing.description.trim(),
      ...(editing.assignee ? { assignee_id: editing.assignee.id } : {}),
      start_date: editing.start_date,
      due_date: editing.due_date,
    }
    try {
      await patchMutation.mutateAsync({ taskId: editing.id, patch })
      setEditing(null)
    } catch {
      // Keep the edit form open so the user can retry.
    }
  }

  const formatDate = (value: string) => {
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
    }).format(new Date(year, month - 1, day))
  }

  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(value))

  const mutationError = createMutation.error || patchMutation.error

  return (
    <div
      className={css({
        width: '100%',
        maxWidth: '64rem',
        marginX: 'auto',
        padding: { base: '1rem', md: '2rem' },
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
      })}
    >
      <header>
        <h1
          className={css({
            margin: 0,
            fontSize: '1.5rem',
            fontWeight: '700',
            color: 'greyscale.900',
          })}
        >
          {t('title')}
        </h1>
        <p
          className={css({
            marginTop: '0.25rem',
            marginBottom: 0,
            color: 'greyscale.600',
            fontSize: '0.875rem',
          })}
        >
          {t('subtitle')}
        </p>
      </header>

      <form
        onSubmit={(event) => void submitCreate(event)}
        className={css({
          display: 'grid',
          gridTemplateColumns: {
            base: '1fr',
            md: 'repeat(2, 1fr)',
            lg: '2fr 1.25fr 1fr 1fr auto',
          },
          gap: '0.75rem',
          padding: '1rem',
          border: '1px solid token(colors.greyscale.200)',
          borderRadius: '10px',
          backgroundColor: 'greyscale.50',
          alignItems: 'end',
        })}
      >
        <label className={labelCss}>
          {t('form.title')}
          <Input
            className={editableControlCss}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('form.titlePlaceholder')}
            maxLength={500}
            required
          />
        </label>
        <label className={labelCss}>
          {t('form.assignee')}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={css({ width: '100%', justifyContent: 'flex-start' })}
            onPress={() => setAssigneePicker('create')}
          >
            {createAssignee
              ? displayName(createAssignee)
              : t('form.assigneeSelf')}
          </Button>
        </label>
        <label className={labelCss}>
          {t('form.startDate')}
          <Input
            className={editableControlCss}
            type="date"
            value={startDate}
            max={dueDate || undefined}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </label>
        <label className={labelCss}>
          {t('form.dueDate')}
          <Input
            className={editableControlCss}
            type="date"
            value={dueDate}
            min={startDate || undefined}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          size="sm"
          loading={createMutation.isPending}
          isDisabled={!title.trim()}
        >
          {t('form.create')}
        </Button>
        <label
          className={`${labelCss} ${css({
            md: { gridColumn: '1 / -1' },
            lg: { gridColumn: '1 / 5' },
          })}`}
        >
          {t('form.description')}
          <TextArea
            className={editableControlCss}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('form.descriptionPlaceholder')}
            maxLength={5000}
            rows={2}
          />
        </label>
      </form>

      <div
        role="tablist"
        aria-label={t('scopes.label')}
        className={css({
          display: 'flex',
          gap: '0.25rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        {scopes.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            onClick={() => setScope(value)}
            className={css({
              border: 'none',
              borderBottom: '2px solid',
              borderBottomColor:
                scope === value ? 'primary.500' : 'transparent',
              color: scope === value ? 'primary.600' : 'greyscale.600',
              backgroundColor: 'transparent',
              paddingX: '0.75rem',
              paddingY: '0.625rem',
              fontWeight: scope === value ? '600' : '400',
              cursor: 'pointer',
            })}
          >
            {t(`scopes.${value}`)}
          </button>
        ))}
      </div>

      {(error || mutationError) && (
        <div
          role="alert"
          className={css({
            padding: '0.75rem',
            borderRadius: '8px',
            color: 'danger.700',
            backgroundColor: 'danger.50',
          })}
        >
          {t('error')}
        </div>
      )}

      {isLoading ? (
        <StateHint loading>{t('loading')}</StateHint>
      ) : !data?.results.length ? (
        <StateHint>{t('empty')}</StateHint>
      ) : (
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          })}
        >
          {data.results.map((task) => (
            <li key={task.id}>
              {editing?.id === task.id ? (
                <form
                  onSubmit={(event) => void submitEdit(event)}
                  className={cardCss}
                >
                  <label className={labelCss}>
                    {t('form.title')}
                    <Input
                      value={editing.title}
                      onChange={(event) =>
                        setEditing({ ...editing, title: event.target.value })
                      }
                      maxLength={500}
                      required
                    />
                  </label>
                  <label className={labelCss}>
                    {t('form.description')}
                    <TextArea
                      value={editing.description}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          description: event.target.value,
                        })
                      }
                      maxLength={5000}
                      rows={3}
                    />
                  </label>
                  <label className={labelCss}>
                    {t('form.assignee')}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={css({
                        width: '100%',
                        justifyContent: 'flex-start',
                      })}
                      onPress={() => setAssigneePicker('edit')}
                    >
                      {displayName(editing.assignee)}
                    </Button>
                  </label>
                  <div
                    className={css({
                      display: 'grid',
                      gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' },
                      gap: '0.75rem',
                    })}
                  >
                    <label className={labelCss}>
                      {t('form.startDate')}
                      <Input
                        type="date"
                        value={editing.start_date || ''}
                        max={editing.due_date || undefined}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            start_date: event.target.value || null,
                          })
                        }
                      />
                    </label>
                    <label className={labelCss}>
                      {t('form.dueDate')}
                      <Input
                        type="date"
                        value={editing.due_date || ''}
                        min={editing.start_date || undefined}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            due_date: event.target.value || null,
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className={actionRowCss}>
                    <Button
                      type="submit"
                      size="dense"
                      loading={patchMutation.isPending}
                    >
                      {t('actions.save')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="dense"
                      onPress={() => setEditing(null)}
                    >
                      {t('actions.cancelEdit')}
                    </Button>
                  </div>
                </form>
              ) : (
                <article className={cardCss}>
                  <div
                    className={css({
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                    })}
                  >
                    <div className={css({ minWidth: 0 })}>
                      <h2
                        className={css({
                          margin: 0,
                          fontSize: '1rem',
                          fontWeight: '600',
                          color: 'greyscale.900',
                          overflowWrap: 'anywhere',
                        })}
                      >
                        {task.title}
                      </h2>
                      {task.description && (
                        <p
                          className={css({
                            marginTop: '0.375rem',
                            marginBottom: 0,
                            color: 'greyscale.700',
                            whiteSpace: 'pre-wrap',
                          })}
                        >
                          {task.description}
                        </p>
                      )}
                    </div>
                    <span className={statusCss(task.status)}>
                      {t(`statuses.${task.status}`)}
                    </span>
                  </div>

                  <dl
                    className={css({
                      margin: 0,
                      display: 'grid',
                      gridTemplateColumns: {
                        base: '1fr',
                        sm: 'repeat(2, 1fr)',
                        lg: 'repeat(5, 1fr)',
                      },
                      gap: '0.5rem 1rem',
                      fontSize: '0.8125rem',
                    })}
                  >
                    <TaskMeta
                      label={t('meta.assignee')}
                      value={displayName(task.assignee)}
                    />
                    <TaskMeta
                      label={t('meta.creator')}
                      value={displayName(task.creator)}
                    />
                    <TaskMeta
                      label={t('meta.startDate')}
                      value={
                        task.start_date
                          ? formatDate(task.start_date)
                          : t('meta.none')
                      }
                    />
                    <TaskMeta
                      label={t('meta.dueDate')}
                      value={
                        task.due_date
                          ? formatDate(task.due_date)
                          : t('meta.none')
                      }
                    />
                    <TaskMeta
                      label={t('meta.createdAt')}
                      value={formatDateTime(task.created_at)}
                    />
                  </dl>

                  {task.source_room_id && (
                    <Link
                      to={`/meetings/${task.source_room_id}`}
                      className={css({
                        color: 'primary.600',
                        fontSize: '0.8125rem',
                        textDecoration: 'none',
                        _hover: { textDecoration: 'underline' },
                      })}
                    >
                      {t('sourceMeeting', {
                        name: task.source_room_name || t('meeting'),
                      })}
                    </Link>
                  )}

                  <div className={actionRowCss}>
                    {task.can_update_status &&
                      nextStatusActions[task.status].map((status) => (
                        <Button
                          key={status}
                          variant={
                            status === 'completed' ? 'primary' : 'secondary'
                          }
                          size="dense"
                          isDisabled={patchMutation.isPending}
                          onPress={() => patchStatus(task, status)}
                        >
                          {t(`actions.to_${status}`)}
                        </Button>
                      ))}
                    {task.can_edit && (
                      <Button
                        variant="secondary"
                        size="dense"
                        onPress={() => setEditing(task)}
                      >
                        {t('actions.edit')}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="dense"
                      aria-expanded={expandedSubtasks.has(task.id)}
                      onPress={() => toggleSubtasks(task.id)}
                    >
                      {expandedSubtasks.has(task.id)
                        ? t('subtasks.hide')
                        : t('subtasks.show', {
                            completed: task.completed_subtask_count,
                            total: task.subtask_count,
                          })}
                    </Button>
                    <Button
                      variant="secondary"
                      size="dense"
                      aria-expanded={expandedComments.has(task.id)}
                      onPress={() => toggleComments(task.id)}
                    >
                      {expandedComments.has(task.id)
                        ? t('comments.hide')
                        : t('comments.show')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="dense"
                      aria-expanded={expandedAttachments.has(task.id)}
                      onPress={() => toggleAttachments(task.id)}
                    >
                      {expandedAttachments.has(task.id)
                        ? t('attachments.hide')
                        : t('attachments.show')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="dense"
                      aria-expanded={expandedActivities.has(task.id)}
                      onPress={() => toggleActivities(task.id)}
                    >
                      {expandedActivities.has(task.id)
                        ? t('history.hide')
                        : t('history.show')}
                    </Button>
                  </div>
                  {expandedSubtasks.has(task.id) && (
                    <TaskSubtasks taskId={task.id} />
                  )}
                  {expandedComments.has(task.id) && (
                    <TaskComments taskId={task.id} />
                  )}
                  {expandedAttachments.has(task.id) && (
                    <TaskAttachments taskId={task.id} />
                  )}
                  {expandedActivities.has(task.id) && (
                    <TaskActivityTimeline taskId={task.id} />
                  )}
                </article>
              )}
            </li>
          ))}
        </ul>
      )}

      {assigneePicker && (
        <ContactPicker
          includeSelf
          title={t('form.selectAssignee')}
          searchPlaceholder={t('form.searchAssignee')}
          onClose={() => setAssigneePicker(null)}
          onSelect={(member) => {
            if (assigneePicker === 'create') {
              setCreateAssignee(member)
            } else if (editing) {
              setEditing({
                ...editing,
                assignee: taskUserFromMember(member),
              })
            }
            setAssigneePicker(null)
          }}
        />
      )}
    </div>
  )
}

const TaskMeta = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className={css({ color: 'greyscale.500' })}>{label}</dt>
    <dd className={css({ margin: 0, color: 'greyscale.800' })}>{value}</dd>
  </div>
)

const TaskSubtasks = ({ taskId }: { taskId: string }) => {
  const { t, i18n } = useTranslation('tasks')
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState<DirectoryMember | null>(null)
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const { data, isLoading, error } = useTaskSubtasks(taskId)
  const createMutation = useCreateTaskSubtask()
  const patchMutation = usePatchTask()

  const formatDate = (value: string) => {
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
    }).format(new Date(year, month - 1, day))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (!cleanTitle) return
    try {
      await createMutation.mutateAsync({
        taskId,
        payload: {
          title: cleanTitle,
          assignee_id: assignee?.id,
          start_date: startDate || null,
          due_date: dueDate || null,
        },
      })
      setTitle('')
      setAssignee(null)
      setStartDate('')
      setDueDate('')
    } catch {
      // Keep the form values available so the user can retry.
    }
  }

  return (
    <section
      aria-label={t('subtasks.title')}
      className={css({
        borderTop: '1px solid token(colors.greyscale.200)',
        paddingTop: '0.875rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <h3
        className={css({
          margin: 0,
          color: 'greyscale.800',
          fontSize: '0.875rem',
          fontWeight: '600',
        })}
      >
        {t('subtasks.title')}
      </h3>
      <form
        onSubmit={(event) => void submit(event)}
        className={css({
          display: 'grid',
          gridTemplateColumns: {
            base: '1fr',
            md: '1.5fr 1fr 1fr 1fr auto',
          },
          gap: '0.625rem',
          alignItems: 'end',
        })}
      >
        <label className={labelCss}>
          {t('subtasks.titleLabel')}
          <Input
            className={editableControlCss}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('subtasks.titlePlaceholder')}
            maxLength={500}
            required
          />
        </label>
        <label className={labelCss}>
          {t('form.assignee')}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={css({ width: '100%', justifyContent: 'flex-start' })}
            onPress={() => setPickerOpen(true)}
          >
            {assignee ? displayName(assignee) : t('form.assigneeSelf')}
          </Button>
        </label>
        <label className={labelCss}>
          {t('form.startDate')}
          <Input
            className={editableControlCss}
            type="date"
            value={startDate}
            max={dueDate || undefined}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </label>
        <label className={labelCss}>
          {t('form.dueDate')}
          <Input
            className={editableControlCss}
            type="date"
            value={dueDate}
            min={startDate || undefined}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          size="sm"
          loading={createMutation.isPending}
          isDisabled={!title.trim()}
        >
          {t('subtasks.create')}
        </Button>
      </form>
      {createMutation.error && (
        <p role="alert" className={historyErrorCss}>
          {t('subtasks.createError')}
        </p>
      )}
      {isLoading ? (
        <p className={historyHintCss}>{t('subtasks.loading')}</p>
      ) : error ? (
        <p className={historyErrorCss}>{t('subtasks.error')}</p>
      ) : !data?.length ? (
        <p className={historyHintCss}>{t('subtasks.empty')}</p>
      ) : (
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          })}
        >
          {data.map((subtask) => (
            <li
              key={subtask.id}
              className={css({
                display: 'flex',
                alignItems: { base: 'flex-start', md: 'center' },
                justifyContent: 'space-between',
                flexDirection: { base: 'column', md: 'row' },
                gap: '0.625rem 1rem',
                padding: '0.75rem',
                borderRadius: '8px',
                backgroundColor: 'greyscale.50',
              })}
            >
              <div className={css({ minWidth: 0 })}>
                <div
                  className={css({
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '0.5rem',
                  })}
                >
                  <strong
                    className={css({
                      color: 'greyscale.800',
                      fontSize: '0.8125rem',
                      overflowWrap: 'anywhere',
                    })}
                  >
                    {subtask.title}
                  </strong>
                  <span className={statusCss(subtask.status)}>
                    {t(`statuses.${subtask.status}`)}
                  </span>
                </div>
                <p
                  className={css({
                    marginTop: '0.25rem',
                    marginBottom: 0,
                    color: 'greyscale.500',
                    fontSize: '0.75rem',
                  })}
                >
                  {t('subtasks.meta', {
                    assignee: displayName(subtask.assignee),
                    start: subtask.start_date
                      ? formatDate(subtask.start_date)
                      : t('meta.none'),
                    due: subtask.due_date
                      ? formatDate(subtask.due_date)
                      : t('meta.none'),
                  })}
                </p>
              </div>
              {subtask.can_update_status && (
                <div className={actionRowCss}>
                  {nextStatusActions[subtask.status].map((status) => (
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
      )}
      {pickerOpen && (
        <ContactPicker
          includeSelf
          title={t('form.selectAssignee')}
          searchPlaceholder={t('form.searchAssignee')}
          onClose={() => setPickerOpen(false)}
          onSelect={(member) => {
            setAssignee(member)
            setPickerOpen(false)
          }}
        />
      )}
    </section>
  )
}

const TaskAttachments = ({ taskId }: { taskId: string }) => {
  const { t, i18n } = useTranslation('tasks')
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState(0)
  const { data, isLoading, error } = useTaskAttachments(taskId)
  const createMutation = useCreateTaskAttachment()
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  const formatSize = (size: number | null) => {
    if (size === null) return t('attachments.unknownSize')
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

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
      // The mutation error remains visible so the user can retry.
    }
  }

  return (
    <section
      aria-label={t('attachments.title')}
      className={css({
        borderTop: '1px solid token(colors.greyscale.200)',
        paddingTop: '0.875rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        })}
      >
        <h3
          className={css({
            margin: 0,
            color: 'greyscale.800',
            fontSize: '0.875rem',
            fontWeight: '600',
          })}
        >
          {t('attachments.title')}
        </h3>
        <input
          ref={inputRef}
          type="file"
          className={css({ display: 'none' })}
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpeg,.jpg,.png,.gif,.webp,.zip"
          onChange={(event) => void selectFile(event)}
        />
        <Button
          variant="secondary"
          size="dense"
          isDisabled={createMutation.isPending}
          onPress={() => inputRef.current?.click()}
        >
          {createMutation.isPending
            ? t('attachments.uploading', { progress })
            : t('attachments.upload')}
        </Button>
      </div>
      {createMutation.error && (
        <p className={historyErrorCss}>{t('attachments.uploadError')}</p>
      )}
      {isLoading ? (
        <p className={historyHintCss}>{t('attachments.loading')}</p>
      ) : error ? (
        <p className={historyErrorCss}>{t('attachments.error')}</p>
      ) : !data?.length ? (
        <p className={historyHintCss}>{t('attachments.empty')}</p>
      ) : (
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          })}
        >
          {data.map((attachment) => (
            <li
              key={attachment.id}
              className={css({
                display: 'flex',
                alignItems: { base: 'flex-start', sm: 'center' },
                justifyContent: 'space-between',
                flexDirection: { base: 'column', sm: 'row' },
                gap: '0.5rem 1rem',
                padding: '0.75rem',
                borderRadius: '8px',
                backgroundColor: 'greyscale.50',
              })}
            >
              <div className={css({ minWidth: 0 })}>
                <p
                  className={css({
                    margin: 0,
                    color: 'greyscale.800',
                    fontWeight: '500',
                    overflowWrap: 'anywhere',
                  })}
                >
                  {attachment.filename}
                </p>
                <p
                  className={css({
                    margin: 0,
                    color: 'greyscale.500',
                    fontSize: '0.75rem',
                  })}
                >
                  {t('attachments.meta', {
                    name: displayName(attachment.uploader),
                    size: formatSize(attachment.size),
                    date: formatDateTime(attachment.created_at),
                  })}
                </p>
              </div>
              <a
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className={css({
                  color: 'primary.600',
                  fontSize: '0.8125rem',
                  fontWeight: '500',
                  textDecoration: 'none',
                  _hover: { textDecoration: 'underline' },
                })}
              >
                {t('attachments.open')}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const TaskComments = ({ taskId }: { taskId: string }) => {
  const { t, i18n } = useTranslation('tasks')
  const [content, setContent] = useState('')
  const { data, isLoading, error } = useTaskComments(taskId)
  const createMutation = useCreateTaskComment()
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(value))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanContent = content.trim()
    if (!cleanContent) return
    try {
      await createMutation.mutateAsync({ taskId, content: cleanContent })
      setContent('')
    } catch {
      // Keep the draft available so the user can retry.
    }
  }

  return (
    <section
      aria-label={t('comments.title')}
      className={css({
        borderTop: '1px solid token(colors.greyscale.200)',
        paddingTop: '0.875rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <h3
        className={css({
          margin: 0,
          color: 'greyscale.800',
          fontSize: '0.875rem',
          fontWeight: '600',
        })}
      >
        {t('comments.title')}
      </h3>
      {isLoading ? (
        <p className={historyHintCss}>{t('comments.loading')}</p>
      ) : error ? (
        <p className={historyErrorCss}>{t('comments.error')}</p>
      ) : !data?.length ? (
        <p className={historyHintCss}>{t('comments.empty')}</p>
      ) : (
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.625rem',
          })}
        >
          {data.map((comment) => (
            <li
              key={comment.id}
              className={css({
                padding: '0.75rem',
                borderRadius: '8px',
                backgroundColor: 'greyscale.50',
              })}
            >
              <div
                className={css({
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: '0.25rem 0.75rem',
                  color: 'greyscale.600',
                  fontSize: '0.75rem',
                })}
              >
                <strong
                  className={css({
                    color: 'greyscale.800',
                    fontWeight: '600',
                  })}
                >
                  {displayName(comment.author)}
                </strong>
                <time dateTime={comment.created_at}>
                  {formatDateTime(comment.created_at)}
                </time>
              </div>
              <p
                className={css({
                  marginTop: '0.375rem',
                  marginBottom: 0,
                  color: 'greyscale.800',
                  fontSize: '0.8125rem',
                  overflowWrap: 'anywhere',
                  whiteSpace: 'pre-wrap',
                })}
              >
                {comment.content}
              </p>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => void submit(event)}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        })}
      >
        <label className={labelCss}>
          {t('comments.inputLabel')}
          <TextArea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t('comments.placeholder')}
            maxLength={2000}
            rows={2}
          />
        </label>
        {createMutation.error && (
          <p role="alert" className={historyErrorCss}>
            {t('comments.postError')}
          </p>
        )}
        <div>
          <Button
            type="submit"
            size="dense"
            loading={createMutation.isPending}
            isDisabled={!content.trim()}
          >
            {t('comments.submit')}
          </Button>
        </div>
      </form>
    </section>
  )
}

const TaskActivityTimeline = ({ taskId }: { taskId: string }) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTaskActivities(taskId)
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(value))

  return (
    <section
      aria-label={t('history.title')}
      className={css({
        borderTop: '1px solid token(colors.greyscale.200)',
        paddingTop: '0.875rem',
      })}
    >
      <h3
        className={css({
          margin: 0,
          color: 'greyscale.800',
          fontSize: '0.875rem',
          fontWeight: '600',
        })}
      >
        {t('history.title')}
      </h3>
      {isLoading ? (
        <p className={historyHintCss}>{t('history.loading')}</p>
      ) : error ? (
        <p className={historyErrorCss}>{t('history.error')}</p>
      ) : !data?.length ? (
        <p className={historyHintCss}>{t('history.empty')}</p>
      ) : (
        <ol
          className={css({
            listStyle: 'none',
            margin: 0,
            paddingTop: '0.75rem',
            paddingLeft: '0.375rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          })}
        >
          {data.map((activity) => (
            <li
              key={activity.id}
              className={css({
                position: 'relative',
                paddingLeft: '1rem',
                borderLeft: '1px solid token(colors.greyscale.300)',
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
              })}
            >
              <p
                className={css({
                  margin: 0,
                  color: 'greyscale.800',
                  fontSize: '0.8125rem',
                })}
              >
                {taskActivityMessage(activity, t)}
              </p>
              <time
                dateTime={activity.created_at}
                className={css({
                  color: 'greyscale.500',
                  fontSize: '0.75rem',
                })}
              >
                {formatDateTime(activity.created_at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const taskActivityMessage = (
  activity: ApiTaskActivity,
  t: TFunction<'tasks'>
) => {
  const actor = displayName(activity.actor)
  if (activity.event === 'status_changed') {
    const status = activity.changes.status?.to
    return t('history.events.status_changed', {
      actor,
      status: status ? t(`statuses.${status}`) : '—',
    })
  }
  if (activity.event === 'assignee_changed') {
    const assignee = activity.changes.assignee
    const target = assignee && 'to' in assignee ? assignee.to?.name : null
    return t('history.events.assignee_changed', {
      actor,
      assignee: target || '—',
    })
  }
  return t(`history.events.${activity.event}`, { actor })
}

const cardCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
  padding: '1rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '10px',
  backgroundColor: 'greyscale.000',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
})

const actionRowCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
})

const historyHintCss = css({
  marginBottom: 0,
  color: 'greyscale.500',
  fontSize: '0.8125rem',
})

const historyErrorCss = css({
  marginBottom: 0,
  color: 'danger.700',
  fontSize: '0.8125rem',
})

const statusCss = (status: TaskStatus) =>
  css({
    flexShrink: 0,
    borderRadius: '999px',
    paddingX: '0.625rem',
    paddingY: '0.25rem',
    fontSize: '0.75rem',
    fontWeight: '600',
    color:
      status === 'completed'
        ? 'success.700'
        : status === 'canceled'
          ? 'greyscale.600'
          : 'primary.700',
    backgroundColor:
      status === 'completed'
        ? 'success.50'
        : status === 'canceled'
          ? 'greyscale.100'
          : 'primary.50',
  })
