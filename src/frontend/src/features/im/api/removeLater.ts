import { fetchApi } from '@/api/fetchApi'

export const removeLater = (id: string): Promise<void> =>
  fetchApi<void>(`/im/later/${id}/`, { method: 'DELETE' })
