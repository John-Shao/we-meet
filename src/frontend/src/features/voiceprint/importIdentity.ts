import { fetchApi } from '@/api/fetchApi'
import {
  getAuthSnapshot,
  sameAuthSession,
  type AuthSnapshot,
} from '@/features/auth/utils/tokenStorage'
import { privateVoiceprintRequest } from './privateRequest'
import type { IdentityPerson, IdentityPage } from './identificationApi'

export type ImportIdentity = {
  organization_id: string | null
  candidate_user_ids: string[]
}
export type ImportIdentityCapability = {
  available: boolean
  reason: string
  max_candidates: number
  max_bytes?: number
  max_duration_ms?: number
}
export type ImportRequest = <T>(
  path: string,
  options?: RequestInit & {
    onUploadProgress?: (sent: number, total: number) => void
  }
) => Promise<T>

/** The whole transfer stays in one login, without imposing a short HTTP timeout. */
export function boundImportRequest(
  owner: string,
  auth: AuthSnapshot,
  identity: boolean
): ImportRequest {
  return async <T>(path: string, options: RequestInit = {}) => {
    if (!sameAuthSession(auth)) throw new Error('authentication_changed')
    options.signal?.throwIfAborted()
    const value = await fetchApi<T>(
      path,
      identity
        ? {
            ...options,
            headers: {
              ...Object.fromEntries(new Headers(options.headers)),
              'X-Voiceprint-Owner': owner,
            },
          }
        : options
    )
    options.signal?.throwIfAborted()
    if (!sameAuthSession(auth)) throw new Error('authentication_changed')
    return value
  }
}

export class ImportIdentityClient {
  constructor(
    readonly owner: string,
    readonly auth = getAuthSnapshot()
  ) {}
  private send<T>(path: string, options: RequestInit) {
    return privateVoiceprintRequest(
      this.auth,
      (signal) =>
        boundImportRequest(
          this.owner,
          this.auth,
          true
        )<T>(path, {
          ...options,
          signal,
          cache: 'no-store',
          redirect: 'error',
        }),
      options.signal
    )
  }
  async candidates(
    organization: string | null,
    q = '',
    offset = 0,
    signal?: AbortSignal
  ) {
    const query = new URLSearchParams({
      organization_id: organization ?? 'personal',
      q,
      offset: String(offset),
    })
    const value = await this.send<
      IdentityPage<IdentityPerson> & { organization_id: string | null }
    >(`recording-uploads/identity-candidates/?${query}`, { signal })
    if (
      !value ||
      value.organization_id !== organization ||
      !Array.isArray(value.results) ||
      value.results.length > 25 ||
      value.results.some(
        (row) =>
          !row ||
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(row.id) ||
          typeof row.name !== 'string' ||
          !row.name.trim() ||
          row.name.length > 512
      ) ||
      new Set(value.results.map((row) => row.id)).size !==
        value.results.length ||
      (organization === null &&
        value.results.some((row) => row.id !== this.owner)) ||
      (value.next_offset !== null &&
        (!Number.isSafeInteger(value.next_offset) ||
          value.next_offset <= offset ||
          value.next_offset > 10000))
    )
      throw new Error('voiceprint_response_invalid')
    return value
  }
  decide<T>(
    record: string,
    attempt: number,
    action: 'retry_identity' | 'continue_without_identity',
    signal?: AbortSignal
  ) {
    return this.send<T>(
      `recording-uploads/${encodeURIComponent(record)}/identity-preflight/`,
      {
        method: 'POST',
        signal,
        body: JSON.stringify({ expected_attempt: attempt, action }),
      }
    )
  }
}
