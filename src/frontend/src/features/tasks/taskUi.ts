import type { ApiTask, ApiTaskUser, TaskStatus } from './api/ApiTask'

export const taskDisplayName = (user: ApiTask['creator'] | null) =>
  user?.full_name || user?.short_name || user?.email || '—'

export const taskAssignees = (task: {
  assignees?: ApiTaskUser[]
  assignee: ApiTaskUser | null
}) => task.assignees ?? (task.assignee ? [task.assignee] : [])

const statusTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['completed'],
  completed: ['todo'],
}

export const nextTaskStatuses = (task: Pick<ApiTask, 'status'>): TaskStatus[] =>
  statusTransitions[task.status]

export const incompleteDescendantCount = (
  task: Pick<ApiTask, 'descendant_progress'>
) =>
  Math.max(
    0,
    task.descendant_progress.total - task.descendant_progress.completed
  )

export const quickTaskStatus = (
  task: Pick<ApiTask, 'status' | 'can_update_status'>
): TaskStatus | undefined => {
  if (!task.can_update_status) return undefined
  return task.status === 'todo' ? 'completed' : 'todo'
}
