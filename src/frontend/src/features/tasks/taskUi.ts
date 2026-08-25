import type { ApiTask, TaskStatus } from './api/ApiTask'

export const taskDisplayName = (user: ApiTask['creator'] | null) =>
  user?.full_name || user?.short_name || user?.email || '—'

const statusTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['completed'],
  completed: ['todo'],
}

export const nextTaskStatuses = (task: Pick<ApiTask, 'status'>): TaskStatus[] =>
  statusTransitions[task.status]

export const quickTaskStatus = (
  task: Pick<ApiTask, 'status' | 'can_update_status'>
): TaskStatus | undefined => {
  if (!task.can_update_status) return undefined
  return task.status === 'todo' ? 'completed' : 'todo'
}
