import { fetchApi } from '@/api/fetchApi'
import type { LaterItem } from './listLater'

export interface MarkLaterPayload {
  cid: string
  mid: string
  seq?: number
  /** Snapshot taken at mark time — keeps the row renderable after recall/delete. */
  snippet?: string
  sender_name?: string
  content_type?: string
}

export const markLater = (payload: MarkLaterPayload): Promise<LaterItem> =>
  fetchApi<LaterItem>('/im/later/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
