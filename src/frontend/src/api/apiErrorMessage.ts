import { ApiError } from './ApiError'

/**
 * Human-readable message for a thrown API error.
 *
 * `ApiError.message` is only the opaque `"Api error <code>"` status string; the
 * useful detail lives on `.body` (DRF returns `{ detail: "…" }` for
 * permission/validation errors, or `{ field: ["…"] }` for field errors). This
 * digs the first usable string out of the body, falling back to the status
 * string and finally a generic stringify for non-API errors.
 */
export const apiErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    const { body } = error
    if (typeof body === 'string' && body) return body
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      if (typeof record.detail === 'string') return record.detail
      const first = Object.values(record)[0]
      if (typeof first === 'string') return first
      if (Array.isArray(first) && typeof first[0] === 'string') return first[0]
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}
