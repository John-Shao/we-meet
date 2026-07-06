import { fetchApi } from '@/api/fetchApi'
import type { LaterItem } from './listLater'

export const doneLater = (id: string): Promise<LaterItem> =>
  fetchApi<LaterItem>(`/im/later/${id}/done/`, { method: 'POST' })
