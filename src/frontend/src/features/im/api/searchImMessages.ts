import { fetchApi } from '@/api/fetchApi'

/** One hit of GET /im/search/ (P1-M1; proxied to jusi p15). */
export interface ImSearchItem {
  mid: number
  cid: string
  sender_uid: string
  seq: number
  content_type: string
  body: string
  /** unix ms */
  created_at: number
}

export interface ImSearchResponse {
  items: ImSearchItem[]
  /** Cursor for the next page; 0 = no more. */
  next_before_mid: number
}

export const searchImMessages = (
  q: string,
  opts: { cid?: string; limit?: number; beforeMid?: number } = {}
): Promise<ImSearchResponse> => {
  const params = new URLSearchParams({ q })
  if (opts.cid) params.set('cid', opts.cid)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.beforeMid) params.set('before_mid', String(opts.beforeMid))
  return fetchApi<ImSearchResponse>(`/im/search/?${params.toString()}`)
}
