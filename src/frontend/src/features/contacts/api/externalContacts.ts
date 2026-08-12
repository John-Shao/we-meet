import { fetchApi } from '@/api/fetchApi'

import type { ExternalContact } from './ApiDirectory'

const BASE = '/directory/external-contacts'

export const fetchExternalContacts = (): Promise<ExternalContact[]> =>
  fetchApi<ExternalContact[]>(`${BASE}/`)

export const fetchExternalContactRequests = (): Promise<ExternalContact[]> =>
  fetchApi<ExternalContact[]>(`${BASE}/requests/`)

export const searchExternalAccounts = (
  query: string
): Promise<ExternalContact[]> =>
  fetchApi<ExternalContact[]>(`${BASE}/search/?q=${encodeURIComponent(query.trim())}`)

export const sendExternalContactRequest = (
  targetUserId: string
): Promise<ExternalContact> =>
  fetchApi<ExternalContact>(`${BASE}/requests/`, {
    method: 'POST',
    body: JSON.stringify({ target_user_id: targetUserId }),
  })

export const acceptExternalContactRequest = (
  relationshipId: string
): Promise<ExternalContact> =>
  fetchApi<ExternalContact>(`${BASE}/${encodeURIComponent(relationshipId)}/accept/`, {
    method: 'POST',
  })

export const declineExternalContactRequest = (
  relationshipId: string
): Promise<ExternalContact> =>
  fetchApi<ExternalContact>(`${BASE}/${encodeURIComponent(relationshipId)}/decline/`, {
    method: 'POST',
  })

export const removeExternalContact = (relationshipId: string): Promise<void> =>
  fetchApi<void>(`${BASE}/${encodeURIComponent(relationshipId)}/`, {
    method: 'DELETE',
  })
