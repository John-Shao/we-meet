import { ApiError } from '@/api/ApiError'

/**
 * Turn a thrown error into a human-readable message for a console alert.
 *
 * `ApiError.message` is only "Api error <code>"; the useful text (DRF
 * `{detail: …}` or per-field errors like `{reassign: […]}`) lives in `body`.
 * Pull that out so admins see "department has sub-departments; …" rather than
 * "Api error 400".
 */
export const describeApiError = (e: unknown): string => {
  if (e instanceof ApiError) {
    const body = e.body
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>
      const val = obj.detail ?? Object.values(obj)[0]
      if (Array.isArray(val) && val.length) return String(val[0])
      if (typeof val === 'string') return val
    }
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}
