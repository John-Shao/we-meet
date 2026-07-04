import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * Audit-log read client for the console (M 端).
 *
 * Backend source: src/backend/core/api/admin_audit.py → GET /admin/audit-logs/
 */
export interface AuditActor {
  id: string
  full_name: string | null
  short_name: string | null
}

export interface AuditLogEntry {
  id: string
  actor: AuditActor | null
  action: string
  target_type: string
  target_id: string
  target_label: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface AuditListParams {
  action?: string
  since?: string
  until?: string
  page?: number
}

export const fetchAuditLogs = (
  params: AuditListParams,
): Promise<Paginated<AuditLogEntry>> => {
  const qs = new URLSearchParams()
  if (params.action) qs.set('action', params.action)
  if (params.since) qs.set('since', params.since)
  if (params.until) qs.set('until', params.until)
  if (params.page) qs.set('page', String(params.page))
  const s = qs.toString()
  return fetchApi<Paginated<AuditLogEntry>>(
    `/admin/audit-logs/${s ? `?${s}` : ''}`,
  )
}

/** Action keys the backend emits (AuditActionChoices), for the filter dropdown. */
export const AUDIT_ACTIONS = [
  'dept.create',
  'dept.rename',
  'dept.delete',
  'member.add',
  'member.update',
  'member.role_change',
  'member.department_change',
  'member.suspend',
  'member.restore',
  'member.remove',
] as const

/** i18n key for an action label (dots → underscores; i18next splits on dots). */
export const actionI18nKey = (action: string) =>
  `audit.action.${action.replace(/\./g, '_')}`
