import { fetchApi } from '@/api/fetchApi'

export type ShareRole = 'reader' | 'editor'
export type MemberRole = ShareRole | 'commenter'

export async function memberIds(docId: string): Promise<string[]> {
  const response = await fetchApi<{ user_ids: string[] }>(
    `/docs/member-access/?doc_id=${encodeURIComponent(docId)}`
  )
  if (
    !Array.isArray(response.user_ids) ||
    response.user_ids.some((id) => typeof id !== 'string')
  )
    throw new Error('Invalid membership response')
  return response.user_ids
}

export async function addDocMembers(
  docId: string,
  ids: string[],
  role: MemberRole
) {
  const response = await fetchApi<{
    identity: string
    role: string
    results: Array<{ user_id: string; status: string }>
  }>('/docs/member-access/', {
    method: 'POST',
    body: JSON.stringify({ doc_id: docId, user_ids: ids, role }),
  })
  if (
    response.identity !== 'user_id' ||
    response.role !== role ||
    !Array.isArray(response.results)
  )
    throw new Error('Unconfirmed membership')
  return ids.filter((id) => {
    const matches = response.results.filter((row) => row?.user_id === id)
    return (
      matches.length !== 1 || !['added', 'existing'].includes(matches[0].status)
    )
  })
}

export async function grantChatAccess(
  docId: string,
  cid: string,
  role: ShareRole
) {
  const response = await fetchApi<{
    scoped: boolean
    complete: boolean
    role: string
  }>('/im/doc-chat-access/', {
    method: 'POST',
    body: JSON.stringify({ doc_id: docId, cid, role }),
  })
  if (
    response.scoped !== true ||
    response.complete !== true ||
    response.role !== role
  )
    throw new Error('Unconfirmed document access')
}
