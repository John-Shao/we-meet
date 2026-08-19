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

/** GET /api/v1.0/approvals?role= — "pending" (awaiting me) or "mine" (I filed).
 *  First page only — used by the rail badge. The module list paginates via
 *  {@link fetchApprovalsPage}. */
export const fetchApprovals = (
  role: 'pending' | 'mine'
): Promise<ApprovalInstance[]> =>
  fetchApi<Paginated<ApprovalInstance>>(`/approvals/?role=${role}`).then(
    (p) => p.results
  )

/** One page of the approval list (page-number pagination) for infinite scroll. */
export const fetchApprovalsPage = (
  role: 'pending' | 'mine',
  page: number
): Promise<Paginated<ApprovalInstance>> =>
  fetchApi<Paginated<ApprovalInstance>>(`/approvals/?role=${role}&page=${page}`)

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

/** POST /api/v1.0/approvals/{id}/urge — applicant nudges the current approver (催办). */
export const urgeApproval = (id: string): Promise<ApprovalInstance> =>
  fetchApi<ApprovalInstance>(`/approvals/${encodeURIComponent(id)}/urge/`, {
    method: 'POST',
    body: '{}',
  })
