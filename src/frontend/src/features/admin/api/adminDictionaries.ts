import { fetchApi } from '@/api/fetchApi'

/**
 * Per-organization option lists (人员类型 / 职级 / 序列 …).
 *
 * Backend source: src/backend/core/api/admin_org.py → OrgDictItemViewSet.
 * Unpaginated on purpose: these lists are short by construction.
 */
export type DictScope =
  | 'employee_type'
  | 'job_level'
  | 'job_sequence'
  | 'onboard_type'
  | 'probation_status'
  | 'leave_reason'

export interface DictItem {
  id: string
  scope: DictScope
  /** Stable identifier application logic branches on — frozen after creation. */
  code: string
  /** Customer-facing label; renaming is always allowed, even for built-ins. */
  label: string
  sort_order: number
  /** Seeded options can be renamed and deactivated but never deleted. */
  is_builtin: boolean
  is_active: boolean
}

export const fetchDictItems = (
  scope?: DictScope,
  includeInactive = false
): Promise<DictItem[]> => {
  const qs = new URLSearchParams()
  if (scope) qs.set('scope', scope)
  if (includeInactive) qs.set('include_inactive', 'true')
  const s = qs.toString()
  return fetchApi<DictItem[]>(`/admin/dictionaries/${s ? `?${s}` : ''}`)
}

export const createDictItem = (input: {
  scope: DictScope
  code: string
  label: string
  sort_order?: number
}): Promise<DictItem> =>
  fetchApi<DictItem>('/admin/dictionaries/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateDictItem = (
  id: string,
  input: { label?: string; sort_order?: number; is_active?: boolean }
): Promise<DictItem> =>
  fetchApi<DictItem>(`/admin/dictionaries/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

export const deleteDictItem = (id: string): Promise<unknown> =>
  fetchApi(`/admin/dictionaries/${id}/`, { method: 'DELETE' })
