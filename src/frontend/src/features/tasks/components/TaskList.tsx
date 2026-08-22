import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { ApiTask } from '../api/ApiTask'
import { usePatchTask } from '../api/fetchTasks'
import { quickTaskStatus, taskDisplayName } from '../taskUi'
import { TaskLabelBadge } from './TaskLabelBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'

export const TaskList = ({
  tasks,
  selectedTaskId,
  onOpen,
  registerRow,
}: {
  tasks: ApiTask[]
  selectedTaskId?: string
  onOpen: (task: ApiTask) => void
  registerRow: (taskId: string, element: HTMLElement | null) => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const patchMutation = usePatchTask()

  const formatDate = (value: string | null) => {
    if (!value) return '—'
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(year, month - 1, day))
  }
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value))

  const updateQuickStatus = (task: ApiTask) => {
    const status = quickTaskStatus(task)
    if (!status) return
    patchMutation.mutate({ taskId: task.id, patch: { status } })
  }

  const openOnEnter = (event: KeyboardEvent<HTMLElement>, task: ApiTask) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(task)
    }
  }

  return (
    <>
      <table className={tableCss}>
        <thead>
          <tr>
            <th className={statusColumnCss}>{t('workspace.columns.status')}</th>
            <th>{t('workspace.columns.title')}</th>
            <th>{t('workspace.columns.assignee')}</th>
            <th>{t('workspace.columns.priority')}</th>
            <th className={secondaryColumnCss}>
              {t('workspace.columns.startDate')}
            </th>
            <th>{t('workspace.columns.dueDate')}</th>
            <th>{t('workspace.columns.labels')}</th>
            <th className={secondaryColumnCss}>
              {t('workspace.columns.creator')}
            </th>
            <th className={wideColumnCss}>
              {t('workspace.columns.updatedAt')}
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const quickStatus = quickTaskStatus(task)
            return (
              <tr
                key={task.id}
                ref={(element) => registerRow(task.id, element)}
                tabIndex={0}
                aria-label={t('workspace.openTask', { title: task.title })}
                data-selected={selectedTaskId === task.id || undefined}
                className={rowCss}
                onClick={() => onOpen(task)}
                onKeyDown={(event) => openOnEnter(event, task)}
              >
                <td className={statusColumnCss}>
                  <button
                    type="button"
                    className={statusButtonCss}
                    data-complete={task.status === 'completed' || undefined}
                    disabled={!quickStatus || patchMutation.isPending}
                    aria-label={
                      quickStatus === 'completed'
                        ? t('workspace.quickComplete', { title: task.title })
                        : t('workspace.quickReopen', { title: task.title })
                    }
                    onClick={(event) => {
                      event.stopPropagation()
                      updateQuickStatus(task)
                    }}
                  >
                    {task.status === 'completed' ? '\u2713' : ''}
                  </button>
                </td>
                <td>
                  <TaskTitle task={task} />
                </td>
                <td>{taskDisplayName(task.assignee)}</td>
                <td>
                  <TaskPriorityBadge priority={task.priority} />
                </td>
                <td className={secondaryColumnCss}>
                  {formatDate(task.start_date)}
                </td>
                <td
                  data-overdue={task.time_state === 'overdue' || undefined}
                  className={dueDateCss}
                >
                  {formatDate(task.due_date)}
                </td>
                <td>
                  <div className={labelsCss}>
                    {task.labels.slice(0, 2).map((label) => (
                      <TaskLabelBadge key={label.id} label={label} />
                    ))}
                    {task.labels.length > 2 && (
                      <span className={moreCss}>+{task.labels.length - 2}</span>
                    )}
                  </div>
                </td>
                <td className={secondaryColumnCss}>
                  {taskDisplayName(task.creator)}
                </td>
                <td className={wideColumnCss}>
                  {formatDateTime(task.updated_at)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <ul className={mobileListCss}>
        {tasks.map((task) => (
          <li key={task.id}>
            <div
              ref={(element) => registerRow(task.id, element)}
              tabIndex={0}
              role="button"
              aria-label={t('workspace.openTask', { title: task.title })}
              data-selected={selectedTaskId === task.id || undefined}
              className={mobileCardCss}
              onClick={() => onOpen(task)}
              onKeyDown={(event) => openOnEnter(event, task)}
            >
              <div className={mobileTitleRowCss}>
                <button
                  type="button"
                  className={statusButtonCss}
                  data-complete={task.status === 'completed' || undefined}
                  disabled={!quickTaskStatus(task) || patchMutation.isPending}
                  aria-label={
                    quickTaskStatus(task) === 'completed'
                      ? t('workspace.quickComplete', { title: task.title })
                      : t('workspace.quickReopen', { title: task.title })
                  }
                  onClick={(event) => {
                    event.stopPropagation()
                    updateQuickStatus(task)
                  }}
                >
                  {task.status === 'completed' ? '\u2713' : ''}
                </button>
                <TaskTitle task={task} />
                <TaskPriorityBadge priority={task.priority} />
              </div>
              <dl className={mobileMetaCss}>
                <div>
                  <dt>{t('workspace.columns.assignee')}</dt>
                  <dd>{taskDisplayName(task.assignee)}</dd>
                </div>
                <div>
                  <dt>{t('workspace.columns.dueDate')}</dt>
                  <dd data-overdue={task.time_state === 'overdue' || undefined}>
                    {formatDate(task.due_date)}
                  </dd>
                </div>
              </dl>
              <div className={labelsCss}>
                {task.labels.map((label) => (
                  <TaskLabelBadge key={label.id} label={label} />
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

const TaskTitle = ({ task }: { task: ApiTask }) => {
  const { t } = useTranslation('tasks')
  return (
    <div className={titleCellCss}>
      <strong>{task.title}</strong>
      <span className={titleMetaCss}>
        {t(`statuses.${task.status}`)}
        {task.subtask_count > 0 &&
          ` · ${t('subtasks.show', {
            completed: task.completed_subtask_count,
            total: task.subtask_count,
          })}`}
        {task.source_room_name &&
          ` · ${t('sourceMeeting', { name: task.source_room_name })}`}
      </span>
    </div>
  )
}

const tableCss = css({
  display: { base: 'none', md: 'table' },
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
  color: 'default.text',
  '& th': {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '0.625rem 0.75rem',
    borderBottom: '1px solid token(colors.greyscale.200)',
    backgroundColor: 'greyscale.50',
    color: 'default.subtle-text',
    fontSize: '0.75rem',
    fontWeight: '500',
    textAlign: 'left',
  },
  '& td': {
    padding: '0.625rem 0.75rem',
    borderBottom: '1px solid token(colors.greyscale.200)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
  },
  '& th:nth-child(2)': { width: '30%' },
})
const rowCss = css({
  cursor: 'pointer',
  outline: 'none',
  _hover: { backgroundColor: 'greyscale.50' },
  _focusVisible: { boxShadow: 'inset 0 0 0 2px token(colors.primary.500)' },
  '&[data-selected]': { backgroundColor: 'primary.50' },
})
const statusColumnCss = css({ width: '3rem' })
const secondaryColumnCss = css({ display: { md: 'none', lg: 'table-cell' } })
const wideColumnCss = css({ display: { md: 'none', xl: 'table-cell' } })
const statusButtonCss = css({
  width: '1.25rem',
  height: '1.25rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.000',
  cursor: 'pointer',
  '&[data-complete]': {
    borderColor: 'success.500',
    backgroundColor: 'success.500',
  },
  _disabled: { cursor: 'default', opacity: 0.6 },
})
const titleCellCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  overflow: 'hidden',
  '& strong': { overflow: 'hidden', textOverflow: 'ellipsis' },
})
const titleMetaCss = css({
  overflow: 'hidden',
  color: 'default.subtle-text',
  fontSize: '0.6875rem',
  textOverflow: 'ellipsis',
})
const labelsCss = css({ display: 'flex', gap: '0.25rem', overflow: 'hidden' })
const moreCss = css({ color: 'default.subtle-text', fontSize: '0.75rem' })
const dueDateCss = css({
  '&[data-overdue]': { color: 'danger.600', fontWeight: '600' },
})
const mobileListCss = css({
  display: { base: 'flex', md: 'none' },
  flexDirection: 'column',
  gap: '0.625rem',
  listStyle: 'none',
  margin: 0,
  padding: '0.75rem',
})
const mobileCardCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '0.875rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  cursor: 'pointer',
  outline: 'none',
  '&[data-selected]': {
    borderColor: 'primary.400',
    backgroundColor: 'primary.50',
  },
  _focusVisible: { boxShadow: '0 0 0 2px token(colors.primary.400)' },
})
const mobileTitleRowCss = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'start',
  gap: '0.625rem',
})
const mobileMetaCss = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.75rem',
  margin: 0,
  '& dt': { color: 'default.subtle-text', fontSize: '0.6875rem' },
  '& dd': { margin: 0, fontSize: '0.8125rem' },
  '& dd[data-overdue]': { color: 'danger.600', fontWeight: '600' },
})
