import { fetchApi } from '@/api/fetchApi'

import type {
  ApprovalInstance,
  ApprovalTemplate,
  Paginated,
  SubmitApprovalPayload,
} from './ApiApproval'

/** GET /api/v1.0/approval-templates — active templates the caller may submit. */
export const fetchApprovalTemplates = (): Promise<ApprovalTemplate[]> =>
  fetchApi<Paginated<ApprovalTemplate>>('/approval-templates/').then(
    (p) => p.results
  )

/** GET /api/v1.0/approvals?role= — "pending" (awaiting me) or "mine" (I filed). */
export const fetchApprovals = (
  role: 'pending' | 'mine'
): Promise<ApprovalInstance[]> =>
  fetchApi<Paginated<ApprovalInstance>>(`/approvals/?role=${role}`).then(
    (p) => p.results
  )

/** POST /api/v1.0/approvals — file a new request off a template. */
export const submitApproval = (
  payload: SubmitApprovalPayload
): Promise<ApprovalInstance> =>
  fetchApi<ApprovalInstance>('/approvals/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

/** POST /api/v1.0/approvals/{id}/act — approve or reject the current node. */
export const actApproval = (
  id: string,
  action: 'approved' | 'rejected',
  comment = ''
): Promise<ApprovalInstance> =>
  fetchApi<ApprovalInstance>(`/approvals/${encodeURIComponent(id)}/act/`, {
    method: 'POST',
    body: JSON.stringify({ action, comment }),
  })

/** POST /api/v1.0/approvals/{id}/cancel — applicant withdraws a pending request. */
export const cancelApproval = (id: string): Promise<ApprovalInstance> =>
  fetchApi<ApprovalInstance>(`/approvals/${encodeURIComponent(id)}/cancel/`, {
    method: 'POST',
    body: '{}',
  })
