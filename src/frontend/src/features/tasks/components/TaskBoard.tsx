import { type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { ApiTask, TaskStatus } from '../api/ApiTask'
import { usePatchTask } from '../api/fetchTasks'
import { formatTaskDate } from '../taskDateFormat'
import { taskAssignees } from '../taskUi'
import { useTaskActionFeedback } from './TaskActionFeedbackContext'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskAssigneesDisplay } from './TaskUserDisplay'

const statuses: TaskStatus[] = ['todo', 'completed']

const transitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['completed'],
  completed: ['todo'],
}

export const TaskBoard = ({
  tasks,
  selectedTaskId,
  onOpen,
}: {
  tasks: ApiTask[]
  selectedTaskId?: string
  onOpen: (task: ApiTask) => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const patchMutation = usePatchTask()
  const { notifyAction, notifyFailure } = useTaskActionFeedback()

  const moveTask = async (task: ApiTask, status: TaskStatus) => {
    if (
      !task.can_update_status ||
      task.status === status ||
      !transitions[task.status].includes(status)
    ) {
      return
    }
    try {
      await patchMutation.mutateAsync({ taskId: task.id, patch: { status } })
      notifyAction({
        taskId: task.id,
        title: task.title,
        kind: status === 'completed' ? 'completed' : 'reopened',
        undoPatch: task.recurrence ? undefined : { status: task.status },
      })
    } catch {
      notifyFailure({ taskId: task.id, title: task.title })
    }
  }

  return (
    <div className={boardCss} aria-label={t('board.title')}>
      {statuses.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status)
        return (
          <section
            key={status}
            className={columnCss}
            data-status={status}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const taskId = event.dataTransfer.getData(
                'application/x-we-meet-task'
              )
              const task = tasks.find((item) => item.id === taskId)
              if (task) void moveTask(task, status)
            }}
          >
            <header className={columnHeaderCss}>
              <span className={statusDotCss} />
              <strong>{t(`statuses.${status}`)}</strong>
              <span>{statusTasks.length}</span>
            </header>
            <div className={cardsCss}>
              {statusTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={cardCss}
                  data-selected={selectedTaskId === task.id || undefined}
                  draggable={task.can_update_status}
                  onDragStart={(event) => startTaskDrag(event, task)}
                  onClick={() => onOpen(task)}
                >
                  <strong>{task.title}</strong>
                  <div className={badgesCss}>
                    <TaskPriorityBadge priority={task.priority} />
                  </div>
                  <div className={cardMetaCss}>
                    <TaskAssigneesDisplay users={taskAssignees(task)} />
                    <span>
                      {task.due_date
                        ? formatTaskDate(task.due_date, i18n.language)
                        : t('meta.none')}
                    </span>
                  </div>
                </button>
              ))}
              {statusTasks.length === 0 && (
                <p className={emptyCss}>{t('board.emptyColumn')}</p>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

const startTaskDrag = (event: DragEvent<HTMLButtonElement>, task: ApiTask) => {
  if (!task.can_update_status) {
    event.preventDefault()
    return
  }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-we-meet-task', task.id)
}

const boardCss = css({
  minWidth: 'max-content',
  minHeight: '100%',
  display: 'grid',
  gridTemplateColumns: {
    base: 'minmax(17rem, 1fr)',
    md: 'repeat(2, minmax(17rem, 1fr))',
  },
  alignItems: 'start',
  gap: '0.75rem',
  padding: '0.875rem',
  backgroundColor: 'greyscale.50',
})
const columnCss = css({
  minHeight: '12rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '10px',
  backgroundColor: 'greyscale.000',
  '&[data-status="completed"]': {
    '& header span:first-child': { backgroundColor: 'success.500' },
  },
})
const columnHeaderCss = css({
  height: '3rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  fontSize: '0.8125rem',
  '& > span:last-child': { marginLeft: 'auto', color: 'greyscale.500' },
})
const statusDotCss = css({
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '999px',
  backgroundColor: 'warning',
})
const cardsCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.625rem',
})
const cardCss = css({
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  textAlign: 'left',
  cursor: 'pointer',
  '&[data-selected]': {
    borderColor: 'selected.accent',
    backgroundColor: 'selected.bg',
  },
  _hover: { borderColor: 'greyscale.400' },
})
const badgesCss = css({ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' })
const cardMetaCss = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '0.5rem',
  color: 'default.subtle-text',
  fontSize: '0.75rem',
})
const emptyCss = css({
  margin: '1.5rem 0',
  color: 'greyscale.400',
  fontSize: '0.75rem',
  textAlign: 'center',
})
