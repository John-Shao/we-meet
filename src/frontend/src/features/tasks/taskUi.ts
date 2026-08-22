import type { ApiTask, TaskStatus } from './api/ApiTask'

export const taskDisplayName = (user: ApiTask['creator'] | null) =>
  user?.full_name || user?.short_name || user?.email || '—'

const statusTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'completed', 'canceled'],
  in_progress: ['todo', 'completed', 'canceled'],
  completed: ['todo'],
  canceled: ['todo'],
}

export const nextTaskStatuses = (
  task: Pick<ApiTask, 'status' | 'can_edit'>
): TaskStatus[] => {
  if (task.status === 'canceled' && !task.can_edit) return []
  return statusTransitions[task.status].filter(
    (status) => status !== 'canceled' || task.can_edit
  )
}

export const quickTaskStatus = (
  task: Pick<ApiTask, 'status' | 'can_edit' | 'can_update_status'>
): TaskStatus | undefined => {
  if (!task.can_update_status) return undefined
  if (task.status === 'todo' || task.status === 'in_progress')
    return 'completed'
  if (task.status === 'completed') return 'todo'
  return task.can_edit ? 'todo' : undefined
}
