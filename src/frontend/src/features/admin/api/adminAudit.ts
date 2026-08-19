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
  params: AuditListParams
): Promise<Paginated<AuditLogEntry>> => {
  const qs = new URLSearchParams()
  if (params.action) qs.set('action', params.action)
  if (params.since) qs.set('since', params.since)
  if (params.until) qs.set('until', params.until)
  if (params.page) qs.set('page', String(params.page))
  const s = qs.toString()
  return fetchApi<Paginated<AuditLogEntry>>(
    `/admin/audit-logs/${s ? `?${s}` : ''}`
  )
}

/**
 * One filterable action, as the backend describes it.
 *
 * `label` is the English enum label — a **fallback**, not the display string.
 * Chinese names live in `zh/admin.json` under `audit.action.*` because the
 * backend's `.po` has no translations for `AuditActionChoices` at all; taking
 * the label as-is would swap the console's Chinese action names for English.
 */
export interface AuditActionOption {
  value: string
  label: string
  group: string
}

/**
 * The action catalogue, straight from `AuditActionChoices`.
 *
 * This used to be a hardcoded list of 10 here while the enum had 53 — so 43
 * kinds of action, every bot action among them, could not be filtered for at
 * all. Fetching it is what makes that drift impossible rather than merely
 * fixed once.
 */
export const fetchAuditActions = (): Promise<AuditActionOption[]> =>
  fetchApi<{ actions: AuditActionOption[] }>('/admin/audit-logs/actions/').then(
    (r) => r.actions
  )

/** i18n key for an action label (dots → underscores; i18next splits on dots). */
export const actionI18nKey = (action: string) =>
  `audit.action.${action.replace(/\./g, '_')}`
