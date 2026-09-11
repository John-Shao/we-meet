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

/** 通讯录列表的可选参数(A–Z 索引用的),都要服务端支持(见 directory.py)。 */
export interface DirectoryListOptions {
  /** 按拼音排序;不传就是服务端的姓名编码序(既有调用点行为不变)。 */
  pinyin?: boolean
  /**
   * 从某个首字母开始:A–Z,或 '#'(数字/符号/空名字那一桶)。服务端给的是
   * 「拼音键 ≥ 起点」而不是「首字母 == 起点」,所以从这里还能一路往下滚到 Z。
   */
  fromInitial?: string | null
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
    // 翻页时用服务端给的 next —— 它已经带着 q/ordering/from_initial,不必再拼一遍。
    return fetchApi<Paginated<DirectoryMember>>(toApiPath(pageUrl))
  }
  const qs = buildQuery([
    ['q', query?.trim()],
    ['ordering', options.pinyin ? 'pinyin' : null],
    ['from_initial', options.fromInitial ?? null],
  ])
  return fetchApi<Paginated<DirectoryMember>>(`/directory/members/${qs}`)
}

export interface DirectoryLetter {
  letter: string
  count: number
}

/**
 * GET /api/v1.0/directory/members/alphabet — 每个首字母各有多少人。
 *
 * A–Z 索引条靠它决定哪些字母可点、显示多少。与列表同一套过滤(部门 / 子树 /
 * 搜索词),所以点进某个部门后字母表跟着变。
 */
export const fetchDirectoryAlphabet = (
  options: DirectoryListOptions & {
    department?: string | null
    includeSubtree?: boolean
    query?: string
  } = {}
): Promise<DirectoryLetter[]> =>
  fetchApi<{ letters: DirectoryLetter[] }>(
    `/directory/members/alphabet/${buildQuery([
      ['department', options.department ?? null],
      ['include_subtree', options.includeSubtree ? 'true' : null],
      ['q', options.query?.trim()],
    ])}`
  ).then((payload) => payload.letters)

/**
 * First page only (≤100). Only for callers that genuinely want a bounded
 * preview — anything that must not miss a member pages with
 * `fetchDirectoryMembersPage`.
 */
export const fetchDirectoryMembers = (
  query?: string
): Promise<DirectoryMember[]> =>
  fetchDirectoryMembersPage(query).then((page) => page.results)
