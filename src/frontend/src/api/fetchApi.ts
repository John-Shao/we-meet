import { ApiError } from './ApiError'
import { apiUrl } from './apiUrl'
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from '@/features/auth/utils/tokenStorage'
import { refreshTokens } from '@/features/auth/api/mobileOtp'

/**
 * Single-flight cache for the refresh-token grant in [attemptSilentRefresh].
 * Concurrent 401s share one round-trip — otherwise the second one would race
 * Keycloak's refresh-token rotation (only the first wins; the rest are
 * `invalid_grant` and would force a re-login).
 */
let inflightRefresh: Promise<string | null> | null = null

export const attemptSilentRefresh = async (): Promise<string | null> => {
  if (inflightRefresh) return inflightRefresh
  const refresh = getRefreshToken()
  if (!refresh) return null
  inflightRefresh = (async () => {
    try {
      const data = await refreshTokens(refresh)
      setTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refresh,
      })
      return data.access_token
    } catch {
      // Either invalid_grant (refresh expired) or network failure. Either
      // way the caller will see the 401 propagate and the user gets
      // bounced back to the login screen. clearTokens runs at the call
      // site once the retry also fails.
      return null
    } finally {
      inflightRefresh = null
    }
  })()
  return inflightRefresh
}

const buildHeaders = (
  bearerToken: string | null,
  csrfToken: string | undefined,
  override: HeadersInit | undefined,
  body: BodyInit | null | undefined
): HeadersInit => ({
  // FormData 必须**不设** Content-Type:只有让浏览器自己写这个头,它才会带上
  // multipart 的 boundary。手写 'application/json'(或哪怕手写 multipart)都会
  // 让服务端解析不出任何字段 —— 表现是「文件没上传」而不是一个报错。
  ...(!(body instanceof FormData) && {
    'Content-Type': 'application/json',
  }),
  ...(!!csrfToken && { 'X-CSRFToken': csrfToken }),
  ...(!!bearerToken && { Authorization: `Bearer ${bearerToken}` }),
  ...override,
})

export const fetchApi = async <T = Record<string, unknown>>(
  url: string,
  options?: RequestInit
): Promise<T> => {
  const csrfToken = getCsrfToken()
  // Bearer token from the mobile OTP login flow. The backend's
  // OIDCAuthentication accepts it the same way the App does. When both a
  // bearer token and a Django session cookie are present, the first
  // accepting auth class wins — which means the bearer takes precedence as
  // long as it's still valid.
  const initialBearer = getAccessToken()
  const target = apiUrl(url)

  let response = await fetch(target, {
    credentials: 'include',
    ...options,
    headers: buildHeaders(
      initialBearer,
      csrfToken,
      options?.headers,
      options?.body
    ),
  })

  // Bearer 401 → attempt one silent refresh, retry once with the new token.
  // If refreshing is impossible (or the refreshed token is also rejected),
  // retry without Authorization before surfacing the 401. A browser can have
  // both a stale mobile-login token in localStorage and a still-valid Django
  // session cookie; DRF checks OIDCAuthentication first, so the stale bearer
  // would otherwise mask that valid session and make the first write fail.
  if (response.status === 401 && initialBearer) {
    const newAccess = await attemptSilentRefresh()
    if (newAccess) {
      response = await fetch(target, {
        credentials: 'include',
        ...options,
        headers: buildHeaders(
          newAccess,
          csrfToken,
          options?.headers,
          options?.body
        ),
      })
    }
    // If the retry is also 401, or we never had a refresh token / it failed,
    // discard the rejected bearer and give the session cookie one chance.
    // A 401 is returned before a protected mutation reaches application
    // code, so retrying the same write here cannot duplicate a successful
    // operation.
    if (response.status === 401) {
      clearTokens()
      response = await fetch(target, {
        credentials: 'include',
        ...options,
        headers: buildHeaders(null, csrfToken, options?.headers, options?.body),
      })
    }
  }

  let result: T
  if (response.status === 204) {
    result = undefined as T
  } else {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      result = undefined as T
    } else {
      result = (await response.json()) as T
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, result)
  }
  return result
}

const getCsrfToken = () => {
  return document.cookie
    .split(';')
    .filter((cookie) => cookie.trim().startsWith('csrftoken='))
    .map((cookie) => cookie.split('=')[1])
    .pop()
}
