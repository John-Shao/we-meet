import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember } from './ApiDirectory'

/** One row of `GET /directory/contact-prefs/` — flags only, no card fields. */
export interface ContactPref {
  user_id: string
  is_starred: boolean
  special_alert: boolean
}

/**
 * `GET /api/v1.0/directory/contact-prefs/` — 两个 flag 的紧凑清单。
 *
 * 与 `fetchStarredContacts` 分工不同:这个只有 id + 布尔,用来给会话列表标记
 * 「从没拉过卡片」的对端;星标联系人页要的是可渲染卡片,走那个。
 */
export const fetchContactPrefs = (): Promise<ContactPref[]> =>
  fetchApi<ContactPref[]>('/directory/contact-prefs/')

/**
 * `PUT /api/v1.0/directory/contact-prefs/{userId}/` —— 设置逐联系人的 flag。
 *
 * 两个 flag **相互独立**(对标企业微信):`is_starred` 只管归类,`special_alert`
 * (他的消息特别提醒)只管通知。**省略的键服务端不动**,所以拨一个开关绝不会顺手
 * 清掉另一个 —— 调用方只传自己在改的那个。
 *
 * 幂等,所以 UI 可以乐观切换开关而不用先读当前状态。返回更新后的成员卡片,两个
 * flag 都带回权威值。
 */
export const setContactPref = (
  userId: string,
  patch: { is_starred?: boolean; special_alert?: boolean }
): Promise<DirectoryMember> =>
  fetchApi<DirectoryMember>(
    `/directory/contact-prefs/${encodeURIComponent(userId)}/`,
    { method: 'PUT', body: JSON.stringify(patch) }
  )
