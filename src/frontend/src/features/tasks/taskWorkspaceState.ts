import type {
  TaskSavedViewConfig,
  TaskColumnId,
  TaskGrouping,
  TaskPriorityFilter,
  TaskOrdering,
  TaskScope,
  TaskStatusFilter,
  TaskTimeFilter,
} from './api/ApiTask'

export type TaskWorkspaceView = 'assigned' | 'created' | 'following' | 'all'
export type TaskWorkspaceMode = 'list' | 'board' | 'analytics'

export interface TaskWorkspaceState {
  scope: TaskScope
  status: TaskStatusFilter
  time: TaskTimeFilter
  priority: TaskPriorityFilter
  ordering: TaskOrdering
  grouping: TaskGrouping
  columns: TaskColumnId[]
  taskList: string
  mode: TaskWorkspaceMode
  task?: string
  savedView?: string
  sharedVia?: string
}

export type TaskWorkspacePreferences = Pick<
  TaskWorkspaceState,
  'status' | 'time' | 'priority' | 'ordering' | 'grouping' | 'mode'
>

export const taskViewPresets: Record<
  TaskWorkspaceView,
  Pick<TaskWorkspaceState, 'scope' | 'status'>
> = {
  assigned: { scope: 'assigned', status: 'open' },
  created: { scope: 'created', status: 'open' },
  following: { scope: 'following', status: 'open' },
  all: { scope: 'all', status: 'open' },
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

export const DEFAULT_TASK_COLUMNS: TaskColumnId[] = [
  'title',
  'assignee',
  'priority',
  'startDate',
  'dueDate',
  'taskList',
  'creator',
  'createdAt',
]

export const defaultTaskColumnsForState = (
  state: Pick<TaskWorkspaceState, 'scope' | 'taskList'>
): TaskColumnId[] =>
  DEFAULT_TASK_COLUMNS.filter((column) => {
    if (state.scope === 'created' && column === 'creator') return false
    if (state.taskList !== 'all' && column === 'taskList') return false
    return true
  })

const TASK_GROUPINGS: readonly TaskGrouping[] = [
  'none',
  'custom',
  'task_list',
  'start_date',
  'due_date',
  'creator',
]
const TASK_COLUMN_IDS: readonly TaskColumnId[] = [
  ...DEFAULT_TASK_COLUMNS,
  'customGroup',
  'completedAt',
]

const parseColumns = (value: string | null): TaskColumnId[] => {
  if (!value) return [...DEFAULT_TASK_COLUMNS]
  const columns = value
    .split(',')
    .filter((column): column is TaskColumnId =>
      TASK_COLUMN_IDS.includes(column as TaskColumnId)
    )
  return columns.includes('title')
    ? [...new Set(columns)]
    : [...DEFAULT_TASK_COLUMNS]
}

export const parseTaskWorkspaceState = (
  params: URLSearchParams
): TaskWorkspaceState => ({
  scope: oneOf(
    params.get('scope'),
    ['assigned', 'created', 'following', 'all'],
    'assigned'
  ),
  status: oneOf(params.get('status'), ['open', 'all', 'completed'], 'open'),
  time: oneOf(
    params.get('time'),
    ['all', 'starting_today', 'due_today', 'overdue'],
    'all'
  ),
  priority: oneOf(
    params.get('priority'),
    ['all', 'none', 'low', 'medium', 'high', 'urgent'],
    'all'
  ),
  ordering: oneOf(params.get('ordering'), TASK_ORDERINGS, ''),
  grouping: oneOf(params.get('grouping'), TASK_GROUPINGS, 'none'),
  columns: parseColumns(params.get('columns')),
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
    time: 'all',
    priority: 'all',
    ordering: '',
    grouping: 'none',
    columns: defaultTaskColumnsForState({
      scope: preset.scope,
      taskList: 'all',
    }),
    taskList: 'all',
    mode: 'list',
    task: undefined,
    savedView: undefined,
  }
}

export const stateForTaskList = (
  state: TaskWorkspaceState,
  taskList: string
): TaskWorkspaceState => ({
  ...state,
  scope: 'all',
  status: 'open',
  time: 'all',
  priority: 'all',
  ordering: '',
  grouping: 'none',
  columns: defaultTaskColumnsForState({ scope: 'all', taskList }),
  taskList,
  mode: 'list',
  task: undefined,
  savedView: undefined,
})

export const taskPreferencesViewKey = (state: TaskWorkspaceState) => {
  if (state.savedView) return `saved:${state.savedView}`
  if (state.taskList === 'unassigned') return 'standalone'
  if (state.taskList !== 'all') return `task-list:${state.taskList}`
  return `quick:${state.scope}`
}

export const taskWorkspacePreferences = (
  state: TaskWorkspaceState
): TaskWorkspacePreferences => ({
  status: state.status,
  time: state.time,
  priority: state.priority,
  ordering: state.ordering,
  grouping: state.grouping,
  mode: state.mode,
})

export const stateWithTaskWorkspacePreferences = (
  state: TaskWorkspaceState,
  preferences?: TaskWorkspacePreferences
): TaskWorkspaceState => (preferences ? { ...state, ...preferences } : state)

export const taskColumnViewKey = (state: TaskWorkspaceState) => {
  if (state.savedView) return `saved:${state.savedView}`
  if (state.taskList === 'unassigned') return 'standalone'
  if (state.taskList !== 'all') return 'task-list'
  return `quick:${state.scope}`
}

export const stateWithStatus = (
  state: TaskWorkspaceState,
  status: TaskStatusFilter
): TaskWorkspaceState => ({
  ...state,
  status,
  time: status === 'completed' ? 'all' : state.time,
})

export const hasActiveTaskFilters = (state: TaskWorkspaceState) => {
  const defaultStatus = state.mode === 'board' ? 'all' : 'open'
  return (
    state.status !== defaultStatus ||
    state.time !== 'all' ||
    state.priority !== 'all'
  )
}

export const buildTaskWorkspaceSearch = (state: TaskWorkspaceState) => {
  const params = new URLSearchParams()
  params.set('scope', state.scope)
  params.set('status', state.status)
  params.set('time', state.time)
  params.set('priority', state.priority)
  if (state.ordering) params.set('ordering', state.ordering)
  params.set('grouping', state.grouping ?? 'none')
  params.set('columns', (state.columns ?? DEFAULT_TASK_COLUMNS).join(','))
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
  version: 2,
  scope: state.scope,
  status: state.status,
  time: state.time,
  priority: state.priority,
  task_list: state.taskList,
  ordering: state.ordering,
  view: state.mode,
  grouping: state.grouping,
  columns: state.columns,
})

// Field-level equality — JSON.stringify comparison would be sensitive to key
// order between the server's config and our locally-built object.
export const savedViewConfigEquals = (
  left: TaskSavedViewConfig,
  right: TaskSavedViewConfig
) =>
  left.version === right.version &&
  left.scope === right.scope &&
  left.status === right.status &&
  left.time === right.time &&
  left.priority === right.priority &&
  left.task_list === right.task_list &&
  left.ordering === right.ordering &&
  left.view === right.view &&
  (left.grouping ?? 'none') === (right.grouping ?? 'none') &&
  (left.columns ?? DEFAULT_TASK_COLUMNS).join(',') ===
    (right.columns ?? DEFAULT_TASK_COLUMNS).join(',')

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
  grouping: config.grouping ?? 'none',
  columns: config.columns ?? [...DEFAULT_TASK_COLUMNS],
  task: undefined,
})

export const effectiveTaskColumns = (state: TaskWorkspaceState) => {
  const columns = state.columns.filter((column) => {
    if (state.scope === 'created' && column === 'creator') return false
    if (state.taskList !== 'all' && column === 'taskList') return false
    return true
  })
  if (state.status === 'completed' && !columns.includes('completedAt')) {
    columns.push('completedAt')
  }
  return columns
}
