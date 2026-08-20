import { useState, type FormEvent } from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'

import { StateHint } from '@/components/StateHint'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  PatchTaskPayload,
  TaskScope,
  TaskStatus,
} from '../api/ApiTask'
import { useCreateTask, usePatchTask, useTasks } from '../api/fetchTasks'

const scopes: TaskScope[] = ['assigned', 'created', 'all']

const nextStatusActions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'completed', 'canceled'],
  in_progress: ['todo', 'completed', 'canceled'],
  completed: ['todo'],
  canceled: ['todo'],
}

const inputCss = css({
  width: '100%',
  minHeight: '2.25rem',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  color: 'control.text',
  backgroundColor: 'greyscale.000',
})

const labelCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.8125rem',
  color: 'greyscale.700',
})

const toIsoOrNull = (value: string) =>
  value ? new Date(value).toISOString() : null

const toLocalInput = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

const displayName = (user: ApiTask['creator'] | null) =>
  user?.full_name || user?.short_name || user?.email || '—'

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
  const [dueAt, setDueAt] = useState('')
  const [editing, setEditing] = useState<ApiTask | null>(null)
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
        due_at: toIsoOrNull(dueAt),
      })
      setTitle('')
      setDescription('')
      setDueAt('')
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  const patchStatus = (task: ApiTask, status: TaskStatus) =>
    patchMutation.mutate({ taskId: task.id, patch: { status } })

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editing || !editing.title.trim()) return
    const patch: PatchTaskPayload = {
      title: editing.title.trim(),
      description: editing.description.trim(),
      due_at: editing.due_at,
    }
    try {
      await patchMutation.mutateAsync({ taskId: editing.id, patch })
      setEditing(null)
    } catch {
      // Keep the edit form open so the user can retry.
    }
  }

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
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
          gridTemplateColumns: { base: '1fr', md: '2fr 1fr auto' },
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
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('form.titlePlaceholder')}
            maxLength={500}
            required
            className={inputCss}
          />
        </label>
        <label className={labelCss}>
          {t('form.dueAt')}
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            className={inputCss}
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
          className={`${labelCss} ${css({ md: { gridColumn: '1 / 3' } })}`}
        >
          {t('form.description')}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('form.descriptionPlaceholder')}
            maxLength={5000}
            rows={2}
            className={inputCss}
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
                    <input
                      value={editing.title}
                      onChange={(event) =>
                        setEditing({ ...editing, title: event.target.value })
                      }
                      className={inputCss}
                      maxLength={500}
                      required
                    />
                  </label>
                  <label className={labelCss}>
                    {t('form.description')}
                    <textarea
                      value={editing.description}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          description: event.target.value,
                        })
                      }
                      className={inputCss}
                      maxLength={5000}
                      rows={3}
                    />
                  </label>
                  <label className={labelCss}>
                    {t('form.dueAt')}
                    <input
                      type="datetime-local"
                      value={toLocalInput(editing.due_at)}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          due_at: toIsoOrNull(event.target.value),
                        })
                      }
                      className={inputCss}
                    />
                  </label>
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
                        sm: 'repeat(3, 1fr)',
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
                      label={t('meta.dueAt')}
                      value={
                        task.due_at ? formatDate(task.due_at) : t('meta.none')
                      }
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
                        variant="tertiaryText"
                        size="dense"
                        onPress={() => setEditing(task)}
                      >
                        {t('actions.edit')}
                      </Button>
                    )}
                  </div>
                </article>
              )}
            </li>
          ))}
        </ul>
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
