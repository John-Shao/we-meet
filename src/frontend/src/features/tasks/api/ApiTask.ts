export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'canceled'
export type TaskTimeState = 'starting_today' | 'due_today' | 'overdue'
export type TaskTimeFilter = 'all' | TaskTimeState

export interface ApiTaskUser {
  id: string
  full_name: string | null
  short_name: string | null
  email?: string | null
}

export interface ApiTask {
  id: string
  title: string
  description: string
  creator: ApiTaskUser
  assignee: ApiTaskUser | null
  status: TaskStatus
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
  | 'attachment_removed'

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
    attachment?: { id: string; filename: string }
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

export interface CreateTaskPayload {
  title: string
  description?: string
  assignee_id?: string
  start_date?: string | null
  due_date?: string | null
}

export interface PatchTaskPayload {
  title?: string
  description?: string
  assignee_id?: string
  start_date?: string | null
  due_date?: string | null
  status?: TaskStatus
}
