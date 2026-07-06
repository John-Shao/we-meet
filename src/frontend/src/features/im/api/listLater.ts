import { fetchApi } from '@/api/fetchApi'

/** One「稍后处理」bookmark row, as returned by /im/later/ (P3-M1). */
export interface LaterItem {
  id: string
  cid: string
  mid: string
  seq: number
  snippet: string
  sender_name: string
  content_type: string
  done_at: string | null
  created_at: string
}

export const listLater = (
  status: 'pending' | 'done' | 'all' = 'pending'
): Promise<LaterItem[]> => fetchApi<LaterItem[]>(`/im/later/?status=${status}`)
