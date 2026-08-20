export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'canceled'

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
  can_edit: boolean
  can_update_status: boolean
  created_at: string
  updated_at: string
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
