import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember, Paginated } from './ApiDirectory'

/**
 * Turn a DRF absolute `next` URL into the path `fetchApi` expects.
 * Falls back to the raw value if it isn't a URL we recognise.
 */
export const toApiPath = (absoluteUrl: string): string => {
  try {
    const url = new URL(absoluteUrl)
    return `${url.pathname.replace(/^\/api\/v1\.0/, '')}${url.search}`
  } catch {
    return absoluteUrl
  }
}

/**
 * GET /api/v1.0/directory/members — org-scoped member directory (one card per
 * user, via their primary membership). Optional `query` filters on name/email.
 *
 * Returns the whole page envelope, not just `results`: callers need `next` to
 * keep paging. Dropping it capped every consumer at the first 100 members —
 * including the pickers behind group creation, starred contacts and calendar
 * invites, where a missing colleague reads as "search is broken" rather than
 * "the list was truncated".
 */

/** 通讯录列表的可选参数(排序 / 部门),都要服务端支持(见 directory.py)。 */
export interface DirectoryListOptions {
  /** 按拼音排序;不传就是服务端的姓名编码序(既有调用点行为不变)。 */
  pinyin?: boolean
  /**
   * 只看某个部门(及其子树由服务端规则决定)。传 null/不传 = 整册。
   *
   * 部门视图也走这个端点,而不是 `departments/{id}/members/`:后者不接受 `q`,
   * 于是「进了部门再筛选」只能靠客户端过滤已加载的那一页;而且它返回的是成员关系
   * 而不是「按主部门归一化后的卡片」,列表上会出现写着别的部门的人。
   */
  department?: string | null
  /**
   * 每页要多少条(服务端上限 100)。列表本身用默认值(20)就够了 —— 滚动会续;
   * 只有「一次要拿全某个部门」这种调用点才值得要满页,少发几次请求。
   * 翻页时不必再传:服务端给的 `next` 里带着它。
   */
  pageSize?: number
}

/** 拼查询串。只带非空键,值一律 encodeURIComponent(与既有写法一致)。 */
export const buildQuery = (
  entries: Array<[string, string | null | undefined]>
): string => {
  const parts = entries
    .filter(([, value]) => !!value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

export const fetchDirectoryMembersPage = (
  query?: string,
  pageUrl?: string,
  options: DirectoryListOptions = {}
): Promise<Paginated<DirectoryMember>> => {
  if (pageUrl) {
    // 翻页时用服务端给的 next —— 它已经带着 q/ordering/department,不必再拼一遍。
    return fetchApi<Paginated<DirectoryMember>>(toApiPath(pageUrl))
  }
  const qs = buildQuery([
    ['q', query?.trim()],
    ['ordering', options.pinyin ? 'pinyin' : null],
    ['department', options.department ?? null],
    ['page_size', options.pageSize ? String(options.pageSize) : null],
  ])
  return fetchApi<Paginated<DirectoryMember>>(`/directory/members/${qs}`)
}

/**
 * First page only (≤100). Only for callers that genuinely want a bounded
 * preview — anything that must not miss a member pages with
 * `fetchDirectoryMembersPage`.
 */
export const fetchDirectoryMembers = (
  query?: string
): Promise<DirectoryMember[]> =>
  fetchDirectoryMembersPage(query).then((page) => page.results)
