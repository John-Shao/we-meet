import { ApiError } from './ApiError'
import { apiUrl } from './apiUrl'
import { clearTokens, getAccessToken } from '@/features/auth/utils/tokenStorage'

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
  const bearerToken = getAccessToken()
  const response = await fetch(apiUrl(url), {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(!!csrfToken && { 'X-CSRFToken': csrfToken }),
      ...(!!bearerToken && { Authorization: `Bearer ${bearerToken}` }),
      ...options?.headers,
    },
  })

  // A 401 on a bearer-authed call means the token has expired. Drop it so
  // subsequent calls (and the next useUser fetch) treat the user as logged
  // out — matches the App's "no silent refresh, just re-login" behaviour.
  if (response.status === 401 && bearerToken) {
    clearTokens()
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
