export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'canceled'
export type TaskStatusFilter = 'open' | 'all' | TaskStatus
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type TaskPriorityFilter = 'all' | TaskPriority
export type TaskTimeState = 'starting_today' | 'due_today' | 'overdue'
export type TaskTimeFilter = 'all' | TaskTimeState
export type TaskOrderingField =
  | 'assignee'
  | 'priority'
  | 'start_date'
  | 'due_date'
  | 'status'
  | 'creator'
  | 'created_at'
export type TaskOrdering = '' | TaskOrderingField | `-${TaskOrderingField}`
export type TaskColor =
  | 'grey'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'purple'

export interface ApiTaskGroup {
  id: string
  name: string
  sort_order: number
  task_count: number
  can_delete: boolean
  created_at: string
  updated_at: string
}

export interface ApiTaskList {
  id: string
  name: string
  description: string
  color: TaskColor
  creator: ApiTaskUser | null
  is_archived: boolean
  can_manage: boolean
  task_count: number
  groups: ApiTaskGroup[]
  created_at: string
  updated_at: string
}

export interface ApiTaskUser {
  id: string
  full_name: string | null
  short_name: string | null
  email?: string | null
  avatar_url: string
}

export interface ApiTask {
  id: string
  title: string
  description: string
  creator: ApiTaskUser
  assignee: ApiTaskUser | null
  status: TaskStatus
  priority: TaskPriority
  task_list: Pick<ApiTaskList, 'id' | 'name' | 'color'> | null
  group: Pick<ApiTaskGroup, 'id' | 'name' | 'sort_order'> | null
  position: number
  start_date: string | null
  due_date: string | null
  completed_at: string | null
  source_action_item_id: string | null
  source_room_id: string | null
  source_room_name: string | null
  parent_id: string | null
  subtask_count: number
  completed_subtask_count: number
  can_edit: boolean
  can_update_status: boolean
  time_state: TaskTimeState | null
  created_at: string
  updated_at: string
}

export type TaskActivityEvent =
  | 'created'
  | 'content_changed'
  | 'dates_changed'
  | 'assignee_changed'
  | 'status_changed'
  | 'priority_changed'
  | 'placement_changed'
  | 'attachment_removed'
  | 'source_action_item_changed'

export type SourceActionItemStatus =
  | 'proposed'
  | 'confirmed'
  | 'completed'
  | 'dismissed'

export interface ApiTaskActivityUserSnapshot {
  id: string
  name: string
}

export interface ApiTaskActivity {
  id: string
  actor: ApiTaskUser | null
  event: TaskActivityEvent
  changes: {
    fields?: Array<'title' | 'description'>
    dates?: Partial<
      Record<
        'start_date' | 'due_date',
        { from: string | null; to: string | null }
      >
    >
    assignee?:
      | ApiTaskActivityUserSnapshot
      | {
          from: ApiTaskActivityUserSnapshot | null
          to: ApiTaskActivityUserSnapshot | null
        }
    status?: { from: TaskStatus; to: TaskStatus }
    priority?: { from: TaskPriority; to: TaskPriority }
    placement?: {
      from: ApiTaskPlacementSnapshot
      to: ApiTaskPlacementSnapshot
    }
    attachment?: { id: string; filename: string }
    source_action_item_sync?: {
      action_item_id: string
      result:
        | 'updated'
        | 'already_aligned'
        | 'skipped_manual_override'
        | 'skipped_conflict'
      from: SourceActionItemStatus
      to: SourceActionItemStatus
      reason?: string
    }
    source_action_item?: {
      id: string
      status: { from: SourceActionItemStatus; to: SourceActionItemStatus }
      overrode_task_sync: boolean
    }
    linked_task_sync?: {
      task_id: string
      result: 'updated' | 'already_aligned' | 'skipped_conflict'
      from: TaskStatus
      to: TaskStatus
      reason?: string
      status_activity_id?: string
    }
    source_action_item_origin?: {
      action_item_id: string
      activity_id: string
    }
  }
  created_at: string
}

export interface ApiTaskComment {
  id: string
  author: ApiTaskUser | null
  content: string
  created_at: string
}

export interface ApiTaskAttachment {
  id: string
  file_id: string
  title: string
  filename: string
  mimetype: string | null
  size: number | null
  url: string
  uploader: ApiTaskUser | null
  created_at: string
}

export type TaskScope = 'assigned' | 'created' | 'all'

export interface ApiTaskPlacementSnapshot {
  task_list: Pick<ApiTaskList, 'id' | 'name' | 'color'> | null
  group: Pick<ApiTaskGroup, 'id' | 'name'> | null
  position: number
}

export interface ApiTaskStatistics {
  summary: {
    total: number
    open: number
    completed: number
    canceled: number
    overdue: number
    completion_rate: number
  }
  workload: Array<{
    assignee_id: string
    assignee__full_name: string | null
    assignee__short_name: string | null
    assignee__email: string | null
    assignee__avatar_url: string
    total: number
    open: number
    completed: number
    overdue: number
  }>
  groups: Array<{
    group_id: string | null
    group__name: string | null
    group__sort_order: number | null
    total: number
    completed: number
  }>
}

export interface CreateTaskPayload {
  title: string
  description?: string
  assignee_id?: string
  start_date?: string | null
  due_date?: string | null
  priority?: TaskPriority
  task_list_id?: string | null
  group_id?: string | null
  position?: number
}

export interface PatchTaskPayload {
  title?: string
  description?: string
  assignee_id?: string
  start_date?: string | null
  due_date?: string | null
  priority?: TaskPriority
  task_list_id?: string | null
  group_id?: string | null
  position?: number
  status?: TaskStatus
}
