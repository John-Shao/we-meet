/** DTOs for the approval API (P5). Mirrors core/api/approval.py. */

export type { Paginated } from '@/api/Paginated'

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'needs_assignment'

export type ApprovalAction =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'skipped'
  | 'notified'

export type ApprovalTaskKind = 'approve' | 'cc'

/** One field of a template's request form (MVP convention over the free-form
 *  form_schema JSON authored in Django admin). */
export interface ApprovalFormField {
  key: string
  label: string
  type?: 'text' | 'textarea' | 'number' | 'date'
  required?: boolean
}

export interface ApprovalFormSchema {
  fields?: ApprovalFormField[]
}

export interface ApprovalTemplate {
  id: string
  name: string
  description: string
  form_schema: ApprovalFormSchema
  flow: unknown[]
  is_active: boolean
}

interface UserLite {
  id: string
  full_name: string | null
}

export interface ApprovalTask {
  node_index: number
  approver: UserLite | null
  action: ApprovalAction
  kind: ApprovalTaskKind
  comment: string
  acted_at: string | null
}

/** Display-only per-node metadata (P5b): mode drives the 会签 label. */
export interface ApprovalNodeMeta {
  index: number
  type: string | null
  /** 'single' | 'and' | 'or' */
  mode: string
}

export interface ApprovalInstance {
  id: string
  template: string
  template_name: string
  applicant: UserLite | null
  form_data: Record<string, string>
  status: ApprovalStatus
  current_node: number
  tasks: ApprovalTask[]
  nodes: ApprovalNodeMeta[]
  created_at: string
}

export interface SubmitApprovalPayload {
  template: string
  form_data: Record<string, string>
}
