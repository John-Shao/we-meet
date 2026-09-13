import { ApiError } from './ApiError'
import { apiUrl } from './apiUrl'
import {
  clearTokens,
  getAuthSnapshot,
  sameAuthSession,
  rotateTokens,
  type AuthSnapshot,
} from '@/features/auth/utils/tokenStorage'
import { refreshTokens } from '@/features/auth/api/mobileOtp'

// A refresh is shared only by requests from the same exact credential pair.
let inflightRefresh: {
  snapshot: AuthSnapshot
  promise: Promise<string | null>
} | null = null
export const attemptSilentRefresh = async (): Promise<string | null> => {
  const snapshot = getAuthSnapshot()
  if (!snapshot.refresh) return null
  if (
    inflightRefresh &&
    JSON.stringify(inflightRefresh.snapshot) === JSON.stringify(snapshot)
  )
    return inflightRefresh.promise
  const entry = { snapshot, promise: Promise.resolve<string | null>(null) }
  entry.promise = (async () => {
    try {
      const data = await refreshTokens(snapshot.refresh!)
      return rotateTokens(
        snapshot,
        data.access_token,
        data.refresh_token ?? snapshot.refresh!
      )
        ? data.access_token
        : null
    } catch {
      return null
    } finally {
      if (inflightRefresh === entry) inflightRefresh = null
    }
  })()
  inflightRefresh = entry
  return entry.promise
}

export const assertAuthSession = (snapshot: AuthSnapshot) => {
  if (!sameAuthSession(snapshot))
    throw new ApiError(401, { detail: 'authentication_changed' })
}

const buildHeaders = (
  bearer: string | null,
  csrf: string | undefined,
  options?: RequestInit
) => {
  const headers = new Headers()
  if (!(options?.body instanceof FormData))
    headers.set('Content-Type', 'application/json')
  if (csrf) headers.set('X-CSRFToken', csrf)
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
  new Headers(options?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

/** Same-login refresh only. Cookie identity discovery is restricted to GET users/me. */
export const authenticatedFetch = async (
  url: string,
  options?: RequestInit
) => {
  let snapshot = getAuthSnapshot()
  const csrf = getCsrfToken()
  const explicit = new Headers(options?.headers).has('Authorization')
  const initial = explicit ? null : snapshot.access
  const request = (bearer: string | null) => {
    assertAuthSession(snapshot)
    options?.signal?.throwIfAborted()
    return fetch(apiUrl(url), {
      credentials: 'include',
      ...options,
      headers: buildHeaders(bearer, csrf, options),
    })
  }
  let response = await request(initial)
  assertAuthSession(snapshot)
  if (response.status === 401 && initial) {
    const current = getAuthSnapshot()
    const refreshed =
      current.access !== initial ? current.access : await attemptSilentRefresh()
    assertAuthSession(snapshot)
    if (refreshed) response = await request(refreshed)
    assertAuthSession(snapshot)
    // Discovery may select the cookie identity; source-bound operations may not.
    if (
      response.status === 401 &&
      (options?.method ?? 'GET').toUpperCase() === 'GET' &&
      /^\/?users\/me\/?$/.test(url)
    ) {
      clearTokens()
      snapshot = getAuthSnapshot()
      response = await request(null)
      assertAuthSession(snapshot)
    }
  }
  return { response, snapshot }
}

export const fetchApi = async <T = Record<string, unknown>>(
  url: string,
  options?: RequestInit,
  binary?: { maxBytes: number }
): Promise<T> => {
  const { response, snapshot } = await authenticatedFetch(url, options)

  let result: T
  if (response.ok && binary) {
    result = (await boundedBlob(response, binary.maxBytes)) as T
  } else if (response.status === 204) {
    result = undefined as T
  } else {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      // A non-JSON error body (e.g. a gateway's HTML 502/504) should keep its
      // text instead of being surfaced as `undefined`. Non-JSON 2xx payloads
      // still resolve to `undefined` to preserve binary/empty response shapes.
      if (!response.ok) {
        throw new ApiError(response.status, await response.text())
      }
      result = undefined as T
    } else {
      result = (await response.json()) as T
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, result)
  }
  assertAuthSession(snapshot)
  return result
}

/** Private audio uses the same authentication fallback, with a hard streaming byte limit. */
export const fetchApiBlob = (
  url: string,
  options: RequestInit,
  maxBytes: number
) => fetchApi<Blob>(url, options, { maxBytes })

async function boundedBlob(response: Response, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('invalid_download_limit')
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('audio_download_too_large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty_audio_download')
  const parts: ArrayBuffer[] = []
  let length = 0
  try {
    for (
      let item = await reader.read();
      !item.done;
      item = await reader.read()
    ) {
      const value = item.value
      length += value.byteLength
      if (length > maxBytes) throw new Error('audio_download_too_large')
      parts.push(new Uint8Array(value).buffer)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return new Blob(parts, {
    type: response.headers.get('Content-Type') || 'application/octet-stream',
  })
}

const getCsrfToken = () => {
  return document.cookie
    .split(';')
    .filter((cookie) => cookie.trim().startsWith('csrftoken='))
    .map((cookie) => cookie.split('=')[1])
    .pop()
}
