export type TaskStatus = 'todo' | 'completed'
export type TaskStatusSnapshot = TaskStatus | 'in_progress' | 'canceled'
export type TaskStatusFilter = 'open' | 'all' | TaskStatus
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type TaskPriorityFilter = 'all' | TaskPriority
export type TaskTimeState = 'starting_today' | 'due_today' | 'overdue'
export type TaskTimeFilter = 'all' | TaskTimeState
export type TaskReminderMinutes = 900 | 360 | 2340 | 3780 | 5220
export type TaskRecurrenceFrequency = 'daily' | 'weekly' | 'monthly'
export type TaskRecurrenceScope = 'one' | 'following'
export type TaskOrderingField =
  | 'assignee'
  | 'priority'
  | 'start_date'
  | 'due_date'
  | 'creator'
  | 'created_at'
export type TaskOrdering = '' | TaskOrderingField | `-${TaskOrderingField}`
export type TaskGrouping =
  | 'none'
  | 'custom'
  | 'task_list'
  | 'start_date'
  | 'due_date'
  | 'creator'
export type TaskColumnId =
  | 'title'
  | 'assignee'
  | 'priority'
  | 'startDate'
  | 'dueDate'
  | 'taskList'
  | 'customGroup'
  | 'creator'
  | 'createdAt'
  | 'completedAt'
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
  can_manage: boolean
  created_at: string
  updated_at: string
}

export interface ApiTaskListGroup {
  id: string
  name: string
  sort_order: number
  creator: ApiTaskUser | null
  can_manage: boolean
  list_count: number
  created_at: string
  updated_at: string
}

export interface ApiTaskList {
  id: string
  name: string
  description: string
  color: TaskColor
  creator: ApiTaskUser | null
  list_group: Pick<ApiTaskListGroup, 'id' | 'name' | 'sort_order'> | null
  is_archived: boolean
  access_role: TaskListAccessRole
  can_manage: boolean
  can_share: boolean
  can_archive: boolean
  can_remove: boolean
  can_delete: boolean
  can_create_tasks: boolean
  task_count: number
  groups: ApiTaskGroup[]
  created_at: string
  updated_at: string
}

export interface ApiStandaloneTaskCount {
  count: number
}

export interface ApiTaskSettings {
  daily_reminder_enabled: boolean
  overdue_marker_enabled: boolean
  default_reminder_minutes: TaskReminderMinutes
}

export type PatchTaskSettingsPayload = Partial<ApiTaskSettings>

export interface ApiTaskReminderPreference {
  enabled: boolean
  reminder_minutes: TaskReminderMinutes | null
  effective_reminder_minutes: TaskReminderMinutes
  global_reminders_enabled: boolean
}

export type PatchTaskReminderPreferencePayload = Partial<
  Pick<ApiTaskReminderPreference, 'enabled' | 'reminder_minutes'>
>

export interface ApiTaskShareResult {
  conversation_ids: string[]
}

export type TaskListAccessRole = 'viewer' | 'editor' | 'owner'

export interface ApiTaskListAccess {
  id: string
  user: ApiTaskUser
  role: TaskListAccessRole
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

export interface ApiTaskAncestor {
  id: string
  title: string
  depth: number
}

export interface ApiTaskSubtreeImpact {
  task_id: string
  node_count: number
  descendant_count: number
  maximum_depth: number
}

export interface ApiTaskParentCandidate {
  id: string
  title: string
  depth: number
  ancestor_path: ApiTaskAncestor[]
}

export interface ApiTask {
  id: string
  title: string
  description: string
  creator: ApiTaskUser
  assignee: ApiTaskUser | null
  assignees?: ApiTaskUser[]
  followers: ApiTaskUser[]
  status: TaskStatus
  priority: TaskPriority
  task_list: Pick<ApiTaskList, 'id' | 'name' | 'color'> | null
  group: Pick<ApiTaskGroup, 'id' | 'name' | 'sort_order'> | null
  parent_id: string | null
  depth: number
  ancestor_path: ApiTaskAncestor[]
  descendant_progress: { completed: number; total: number }
  can_create_subtasks: boolean
  position: number
  start_date: string | null
  due_date: string | null
  completed_at: string | null
  recurrence?: ApiTaskRecurrence | null
  source_action_item_id: string | null
  source_room_id: string | null
  source_room_name: string | null
  can_edit: boolean
  can_update_status: boolean
  can_delete: boolean
  can_comment: boolean
  can_manage_attachments: boolean
  can_manage_followers: boolean
  can_manage_reminder?: boolean
  is_following: boolean
  time_state: TaskTimeState | null
  created_at: string
  updated_at: string
}

export interface ApiTaskRecurrence {
  rule_id: string
  frequency: TaskRecurrenceFrequency
  interval: number
  timezone: string
  end_date: string | null
  max_occurrences: number | null
  generated_count: number
  next_occurrence_date: string | null
  is_active: boolean
  last_error: string
  sequence: number
  can_manage: boolean
}

export interface TaskRecurrencePayload {
  frequency: TaskRecurrenceFrequency
  interval?: number
  end_date?: string | null
  max_occurrences?: number | null
}

export type TaskActivityEvent =
  | 'created'
  | 'content_changed'
  | 'dates_changed'
  | 'assignee_changed'
  | 'status_changed'
  | 'priority_changed'
  | 'placement_changed'
  | 'hierarchy_changed'
  | 'recurrence_changed'
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
  task_id: string
  task_title: string
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
    assignees?:
      | ApiTaskActivityUserSnapshot[]
      | {
          from: ApiTaskActivityUserSnapshot[]
          to: ApiTaskActivityUserSnapshot[]
        }
    status?: { from: TaskStatusSnapshot; to: TaskStatusSnapshot }
    priority?: { from: TaskPriority; to: TaskPriority }
    placement?: {
      from: ApiTaskPlacementSnapshot
      to: ApiTaskPlacementSnapshot
    }
    parent?: {
      from: { id: string; title: string } | null
      to: { id: string; title: string } | null
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
      from: TaskStatusSnapshot
      to: TaskStatusSnapshot
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

export type TaskScope = 'assigned' | 'created' | 'following' | 'all'

export interface ApiTaskPlacementSnapshot {
  task_list: Pick<ApiTaskList, 'id' | 'name' | 'color'> | null
  group: Pick<ApiTaskGroup, 'id' | 'name'> | null
  position: number
}

export interface ApiTaskStatistics {
  hierarchy_scope: 'include_descendants' | 'roots_only'
  summary: {
    total: number
    open: number
    completed: number
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
  assignee_ids?: string[]
  follower_ids?: string[]
  start_date?: string | null
  due_date?: string | null
  priority?: TaskPriority
  task_list_id?: string | null
  group_id?: string | null
  position?: number
  parent_id?: string | null
  recurrence?: TaskRecurrencePayload
  reminder?: PatchTaskReminderPreferencePayload
}

export interface PatchTaskPayload {
  title?: string
  description?: string
  assignee_id?: string
  assignee_ids?: string[]
  start_date?: string | null
  due_date?: string | null
  priority?: TaskPriority
  task_list_id?: string | null
  group_id?: string | null
  position?: number
  parent_id?: string | null
  confirm_subtree_node_count?: number
  status?: TaskStatus
  recurrence_scope?: TaskRecurrenceScope
}
