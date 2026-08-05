import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * 群机器人治理(M 端)。
 *
 * 后端:`src/backend/core/api/admin_bots.py`。
 *
 * **刻意没有 create / update / destroy** —— 装机器人是群主在 C 端做的;删除
 * 要调 jusi remove_members 并在群里留痕。M 端的手段只有停用:可见、可逆。
 * 密钥轮换也不给:那是无声的破坏(对方 CI 收到 400,群里什么都不显示)。
 */

export interface AdminBot {
  id: string
  cid: string
  /** 可能为空 —— jusi 没有 admin 读接口,投影是本表建立之后才开始攒的。 */
  conversation_name: string
  name: string
  kind: 'custom' | 'builtin'
  slug: string
  avatar_color_index: number
  is_active: boolean
  disabled_reason: string
  message_count: number
  last_used_at: string | null
  created_at: string
  created_by_name: string
  /** 只说有没有配回调,不给地址 —— 那是群主填的运维细节。 */
  has_callback: boolean
}

export interface AdminBotListParams {
  /** 缺省只列自定义机器人:内置助手是(助手 × 会话)的积,会把真正要治理的冲没。 */
  kind?: '' | 'custom' | 'builtin'
  active?: '' | '1' | '0'
  q?: string
  page?: number
}

export const fetchAdminBots = (
  params: AdminBotListParams,
): Promise<Paginated<AdminBot>> => {
  const qs = new URLSearchParams()
  if (params.kind) qs.set('kind', params.kind)
  if (params.active) qs.set('active', params.active)
  if (params.q) qs.set('q', params.q)
  if (params.page) qs.set('page', String(params.page))
  const s = qs.toString()
  return fetchApi<Paginated<AdminBot>>(`/admin/bots/${s ? `?${s}` : ''}`)
}

export const disableAdminBot = (id: string, reason: string): Promise<AdminBot> =>
  fetchApi<AdminBot>(`/admin/bots/${id}/disable/`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })

export const enableAdminBot = (id: string): Promise<AdminBot> =>
  fetchApi<AdminBot>(`/admin/bots/${id}/enable/`, { method: 'POST' })

export interface AdminBotCredential {
  webhook_url: string
  signing_secret: string
  sign_verify_enabled: boolean
}

/**
 * 一次一行,而且服务端每次记一条 `surface=admin` 的审计 + 30/hour 限流。
 *
 * 所以**永远不要在列表里预取它** —— 一页 100 行就是 100 张活凭证进了浏览器
 * 内存和 HTTP 缓存,外加 100 条审计。
 */
export const fetchAdminBotCredential = (
  id: string,
): Promise<AdminBotCredential> =>
  fetchApi<AdminBotCredential>(`/admin/bots/${id}/credential/`)
