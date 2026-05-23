/**
 * localStorage-backed store for the bearer token issued by the mobile OTP
 * login flow (POST /api/mobile/auth/verify-otp/).
 *
 * Mirrors the Android client's TokenStore: access_token + refresh_token +
 * phone are persisted so a page reload keeps the user signed in. No silent
 * refresh — on 401 the caller clears tokens and the user re-enters the OTP
 * dialog. This matches what the App does today and keeps both clients on
 * the same expiry budget.
 *
 * The fetchApi helper reads the access token on every call and attaches it
 * as `Authorization: Bearer <token>`. The backend's OIDCAuthentication
 * validates the token via Keycloak userinfo, so the existing /users/me/
 * route just works.
 */

const KEY_ACCESS = 'we-meet:access_token'
const KEY_REFRESH = 'we-meet:refresh_token'
const KEY_PHONE = 'we-meet:phone'

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    // localStorage can throw in privacy modes / sandboxed iframes
    return null
  }
}

export const getAccessToken = (): string | null =>
  storage()?.getItem(KEY_ACCESS) ?? null

export const getRefreshToken = (): string | null =>
  storage()?.getItem(KEY_REFRESH) ?? null

export const getStoredPhone = (): string | null =>
  storage()?.getItem(KEY_PHONE) ?? null

export const setTokens = (params: {
  accessToken: string
  refreshToken?: string | null
  phone?: string | null
}) => {
  const s = storage()
  if (!s) return
  s.setItem(KEY_ACCESS, params.accessToken)
  if (params.refreshToken) {
    s.setItem(KEY_REFRESH, params.refreshToken)
  } else {
    s.removeItem(KEY_REFRESH)
  }
  if (params.phone) {
    s.setItem(KEY_PHONE, params.phone)
  }
}

export const clearTokens = () => {
  const s = storage()
  if (!s) return
  s.removeItem(KEY_ACCESS)
  s.removeItem(KEY_REFRESH)
  s.removeItem(KEY_PHONE)
}

export const hasBearerToken = (): boolean => !!getAccessToken()
