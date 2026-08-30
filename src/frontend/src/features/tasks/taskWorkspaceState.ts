import type {
  TaskSavedViewConfig,
  TaskPriorityFilter,
  TaskOrdering,
  TaskScope,
  TaskStatusFilter,
  TaskTimeFilter,
} from './api/ApiTask'

export type TaskWorkspaceView =
  | 'assigned'
  | 'created'
  | 'following'
  | 'all'
  | 'completed'
export type TaskWorkspaceMode = 'list' | 'board' | 'analytics'

export interface TaskWorkspaceState {
  scope: TaskScope
  status: TaskStatusFilter
  time: TaskTimeFilter
  priority: TaskPriorityFilter
  ordering: TaskOrdering
  taskList: string
  mode: TaskWorkspaceMode
  task?: string
  savedView?: string
  sharedVia?: string
}

export const taskViewPresets: Record<
  TaskWorkspaceView,
  Pick<TaskWorkspaceState, 'scope' | 'status'>
> = {
  assigned: { scope: 'assigned', status: 'open' },
  created: { scope: 'created', status: 'open' },
  following: { scope: 'following', status: 'open' },
  all: { scope: 'all', status: 'open' },
  completed: { scope: 'all', status: 'completed' },
}

const oneOf = <T extends string>(
  value: string | null,
  values: readonly T[],
  fallback: T
): T => (value && values.includes(value as T) ? (value as T) : fallback)

const TASK_ORDERINGS: readonly TaskOrdering[] = [
  '',
  'assignee',
  '-assignee',
  'priority',
  '-priority',
  'start_date',
  '-start_date',
  'due_date',
  '-due_date',
  'creator',
  '-creator',
  'created_at',
  '-created_at',
]

export const parseTaskWorkspaceState = (
  params: URLSearchParams
): TaskWorkspaceState => ({
  scope: oneOf(
    params.get('scope'),
    ['assigned', 'created', 'following', 'all'],
    'assigned'
  ),
  status: oneOf(
    params.get('status'),
    ['open', 'all', 'todo', 'completed'],
    'open'
  ),
  time: oneOf(
    params.get('time'),
    ['all', 'starting_today', 'due_today', 'overdue'],
    'all'
  ),
  priority: oneOf(
    params.get('priority'),
    ['all', 'low', 'medium', 'high', 'urgent'],
    'all'
  ),
  ordering: oneOf(params.get('ordering'), TASK_ORDERINGS, ''),
  taskList: params.get('task_list') || 'all',
  mode: oneOf(params.get('view'), ['list', 'board', 'analytics'], 'list'),
  task: params.get('task') || undefined,
  savedView: params.get('saved_view') || undefined,
  sharedVia: params.get('shared_via') || undefined,
})

export const stateForView = (
  state: TaskWorkspaceState,
  view: TaskWorkspaceView
): TaskWorkspaceState => {
  const preset = taskViewPresets[view]
  return {
    ...state,
    ...preset,
    taskList: 'all',
    time: preset.status === 'open' ? state.time : 'all',
    savedView: undefined,
  }
}

export const stateForTaskList = (
  state: TaskWorkspaceState,
  taskList: string
): TaskWorkspaceState => ({
  ...state,
  scope: 'all',
  status: taskList === 'unassigned' || state.mode !== 'list' ? 'all' : 'open',
  time: 'all',
  priority: taskList === 'unassigned' ? 'all' : state.priority,
  taskList,
  task: undefined,
  savedView: undefined,
})

export const stateWithStatus = (
  state: TaskWorkspaceState,
  status: TaskStatusFilter
): TaskWorkspaceState => ({
  ...state,
  status,
  time: status === 'completed' ? 'all' : state.time,
})

export const hasActiveTaskFilters = (state: TaskWorkspaceState) =>
  state.status !== (state.mode === 'board' ? 'all' : 'open') ||
  state.time !== 'all' ||
  state.priority !== 'all'

export const buildTaskWorkspaceSearch = (state: TaskWorkspaceState) => {
  const params = new URLSearchParams()
  params.set('scope', state.scope)
  params.set('status', state.status)
  params.set('time', state.time)
  params.set('priority', state.priority)
  if (state.ordering) params.set('ordering', state.ordering)
  params.set('task_list', state.taskList)
  params.set('view', state.mode)
  if (state.task) params.set('task', state.task)
  if (state.savedView) params.set('saved_view', state.savedView)
  if (state.sharedVia) params.set('shared_via', state.sharedVia)
  return params.toString()
}

export const taskWorkspaceStateToSavedViewConfig = (
  state: TaskWorkspaceState
): TaskSavedViewConfig => ({
  version: 1,
  scope: state.scope,
  status: state.status,
  time: state.time,
  priority: state.priority,
  task_list: state.taskList,
  ordering: state.ordering,
  view: state.mode,
})

export const stateForSavedView = (
  state: TaskWorkspaceState,
  config: TaskSavedViewConfig
): TaskWorkspaceState => ({
  ...state,
  scope: config.scope,
  status: config.status,
  time: config.time,
  priority: config.priority,
  taskList: config.task_list,
  ordering: config.ordering,
  mode: config.view,
  task: undefined,
})
