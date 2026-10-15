import { fetchApi } from '@/api/fetchApi'

export interface RemoteControlPolicy {
  enabled: boolean
  controllers: string[] | null
  targets: string[] | null
  max_seconds: number
  requests_per_minute: number
  rejection_cooldown_seconds: number
}

export interface RemoteControlPolicyView {
  organizationId: string
  version: string
  valid: boolean
  globalEnabled: boolean
  openSessions: number
  policy: RemoteControlPolicy
  members: { id: string; name: string }[]
  revokedSessions?: number
}

const root = '/admin/remote-control/'
export const fetchRemoteControlPolicy = () =>
  fetchApi<RemoteControlPolicyView>(`${root}policy/`)

export const saveRemoteControlPolicy = (
  version: string,
  policy: RemoteControlPolicy
) =>
  fetchApi<RemoteControlPolicyView>(`${root}policy/`, {
    method: 'PUT',
    body: JSON.stringify({ version, policy }),
  })

export const closeRemoteControl = () =>
  fetchApi<RemoteControlPolicyView>(`${root}emergency-close/`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const fetchRemoteControlMembers = ({
  query,
  cursor,
}: {
  query: string
  cursor?: string
}) => {
  const params = new URLSearchParams({ q: query })
  if (cursor) params.set('after', cursor)
  return fetchApi<{
    results: { id: string; name: string }[]
    next_cursor: string | null
  }>(`${root}members/?${params}`)
}
