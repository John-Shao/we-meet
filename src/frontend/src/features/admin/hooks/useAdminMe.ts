/**
 * The caller's org + role.
 *
 * Thin re-export of the app-level `useOrgContext` so the C 端 Header can read
 * `is_org_admin` without importing this module (which would pull the whole
 * console into the main bundle). Kept as a named alias because the console's
 * own components read more naturally as "admin me".
 */
export {
  useOrgContext as useAdminMe,
  type OrgContext as AdminMe,
} from '@/hooks/useOrgContext'
