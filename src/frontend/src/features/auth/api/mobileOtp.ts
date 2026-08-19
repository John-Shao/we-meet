/**
 * Thin wrappers around the mobile OTP login endpoints. These endpoints live
 * outside the standard /api/v1.0/ namespace (their path is
 * /api/mobile/auth/...), so they bypass fetchApi and talk to the origin
 * directly. They also opt out of credentials/CSRF: the OTP flow is
 * anonymous by design — neither send-otp nor verify-otp inspects the
 * caller's existing Django session.
 *
 * Errors come back from the backend as `{"error": "<chinese message>"}`
 * with status 400 / 429 / 503. The wrappers surface that message to the
 * caller as a thrown Error so the dialog can show it inline.
 */

import { setTokens } from '../utils/tokenStorage'

const mobileAuthUrl = (path: string): string => {
  const origin =
    import.meta.env.VITE_API_BASE_URL ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  const sanitizedOrigin = origin.replace(/\/$/, '')
  return `${sanitizedOrigin}/api/mobile/auth/${path.replace(/^\//, '')}`
}

const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(mobileAuthUrl(path), {
    method: 'POST',
    // No credentials: the mobile auth endpoints are anonymous; sending the
    // existing OIDC session cookie would be harmless but pointless.
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: Record<string, unknown> = {}
  try {
    data = await response.json()
  } catch {
    // Some 503/timeout paths can yield a non-JSON body; fall through.
  }
  if (!response.ok) {
    const message =
      (typeof data.error === 'string' && data.error) ||
      `HTTP ${response.status}`
    const err = new Error(message) as Error & { status?: number }
    err.status = response.status
    throw err
  }
  return data as T
}

export interface SendOtpResponse {
  success: boolean
  expires_in: number
}

export const sendOtp = (phone: string): Promise<SendOtpResponse> =>
  postJson<SendOtpResponse>('send-otp/', { phone })

export interface VerifyOtpResponse {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export const verifyOtp = async (
  phone: string,
  otp: string
): Promise<VerifyOtpResponse> => {
  const data = await postJson<VerifyOtpResponse>('verify-otp/', { phone, otp })
  setTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    phone,
  })
  return data
}

/**
 * Refresh-token grant — trades a refresh_token for a fresh access/refresh
 * pair. The backend talks to Keycloak with the client_secret so we don't
 * ship one on the web. On the server's 401 (invalid_grant — refresh expired
 * / revoked / replayed) this throws an Error with status=401 so callers can
 * distinguish "definitely re-login" from transient failures.
 *
 * Note: Keycloak rotates refresh tokens by default; the response carries a
 * new refresh_token that replaces the old one in [setTokens].
 */
export const refreshTokens = (
  refresh_token: string
): Promise<VerifyOtpResponse> =>
  postJson<VerifyOtpResponse>('refresh/', { refresh_token })
