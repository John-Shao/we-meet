import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * Organization invitation client for the console (M 端).
 *
 * Admins pre-provision a person (email + destination department / role / title);
 * their Membership is materialized on first login. Backend:
 * src/backend/core/api/admin_invitations.py.
 */
export interface OrgInvitation {
  id: string
  email: string
  department: { id: string; name: string } | null
  org_role: string
  title: string
  status: string
  invited_by: { id: string; full_name: string | null; short_name: string | null } | null
  created_at: string
}

export interface CreateInvitationInput {
  email: string
  department?: string | null
  org_role?: string
  title?: string
}

export const fetchInvitations = (
  status = 'pending',
): Promise<Paginated<OrgInvitation>> =>
  fetchApi<Paginated<OrgInvitation>>(
    `/admin/invitations/?status=${encodeURIComponent(status)}`,
  )

export const createInvitation = (
  input: CreateInvitationInput,
): Promise<OrgInvitation> =>
  fetchApi<OrgInvitation>('/admin/invitations/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const revokeInvitation = (id: string): Promise<unknown> =>
  fetchApi(`/admin/invitations/${id}/`, { method: 'DELETE' })
