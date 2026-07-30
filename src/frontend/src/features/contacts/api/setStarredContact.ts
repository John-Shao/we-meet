import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember } from './ApiDirectory'

/**
 * 打/取消星标(`/api/v1.0/directory/starred/`)。两个方向都是幂等的,所以 UI 可以
 * 乐观切换开关而不用先读当前状态。
 *
 * POST 返回更新后的成员卡片(`is_starred: true`);DELETE 返回 204,无 body。
 */
export const starContact = (userId: string): Promise<DirectoryMember> =>
  fetchApi<DirectoryMember>('/directory/starred/', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })

export const unstarContact = (userId: string): Promise<void> =>
  fetchApi<void>(`/directory/starred/${encodeURIComponent(userId)}/`, {
    method: 'DELETE',
  })

/** 一次调用切到目标状态 —— 调用方只需说「要不要星标」。 */
export const setStarredContact = (
  userId: string,
  starred: boolean
): Promise<unknown> =>
  starred ? starContact(userId) : unstarContact(userId)
