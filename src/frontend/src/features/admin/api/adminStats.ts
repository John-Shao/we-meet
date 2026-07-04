import { fetchApi } from '@/api/fetchApi'

/**
 * Console dashboard overview (read-only, org-scoped, briefly cached server-side).
 *
 * Backend source: src/backend/core/api/admin_stats.py → GET /admin/stats/overview/
 */
export interface TrendPoint {
  date: string
  count: number
}

export interface AdminStatsOverview {
  members: { total: number; active: number; suspended: number; invited: number }
  departments: number
  meetings: number
  summaries: number
  approvals: { pending: number; total: number }
  trend: TrendPoint[]
}

export const fetchAdminStatsOverview = (): Promise<AdminStatsOverview> =>
  fetchApi<AdminStatsOverview>('/admin/stats/overview/')
