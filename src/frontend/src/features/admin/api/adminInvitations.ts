import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * Organization invitation client for the console (M 端).
 *
 * Admins pre-provision a person (phone or email + destination department /
 * role / title); their Membership is materialized on first login. Backend:
 * src/backend/core/api/admin_invitations.py.
 *
 * Phone is the key that matters (P10 M2-g): we-meet signs people in with a
 * mobile OTP, so an administrator has numbers, not mailboxes.
 */
export interface OrgInvitation {
  id: string
  email: string
  phone: string
  full_name: string
  department: { id: string; name: string } | null
  org_role: string
  title: string
  status: string
  invited_by: { id: string; full_name: string | null; short_name: string | null } | null
  created_at: string
}

export interface CreateInvitationInput {
  /** At least one of phone / email is required by the backend. */
  phone?: string
  email?: string
  full_name?: string
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
