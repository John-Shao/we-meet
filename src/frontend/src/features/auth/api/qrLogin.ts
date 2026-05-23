/**
 * Web-side wrapper for the QR-code login dance.
 *
 *   initiateQrLogin() → {token, expiresIn}
 *     ↓ render QR encoding   we-meet://qr-login?token=<token>
 *   pollQrLogin(token) every 2s
 *     ↓ status: pending | scanned (with {phone,name}) | confirmed | cancelled | expired
 *   on `confirmed` → tokens stashed in localStorage via setTokens(), the React
 *     query for /users/me/ is invalidated, the rest of the app sees a logged-in
 *     user (see fetchApi.ts auth header injection).
 *
 * The polling loop lives in QrLoginPanel.tsx — this file just owns the URL
 * shape and the response type, so views stay declarative.
 */

const apiBase = (): string => {
  const origin =
    import.meta.env.VITE_API_BASE_URL ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  return `${origin.replace(/\/$/, '')}/api/qr-login`
}

const postJson = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${apiBase()}/${path}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  let data: Record<string, unknown> = {}
  try {
    data = await response.json()
  } catch {
    // Empty body is fine for some success paths.
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

export interface InitiateQrLoginResponse {
  token: string
  expires_in: number
}

export const initiateQrLogin = (): Promise<InitiateQrLoginResponse> =>
  postJson<InitiateQrLoginResponse>('initiate/')

export type QrLoginStatus =
  | 'pending'
  | 'scanned'
  | 'confirmed'
  | 'cancelled'
  | 'expired'

export interface QrLoginPollResponse {
  status: QrLoginStatus
  user?: { phone: string; name: string }
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export const pollQrLogin = async (
  token: string
): Promise<QrLoginPollResponse> => {
  const url = new URL(`${apiBase()}/poll/`)
  url.searchParams.set('token', token)
  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'omit',
  })
  if (!response.ok) {
    throw new Error(`poll HTTP ${response.status}`)
  }
  return (await response.json()) as QrLoginPollResponse
}

/** Deep-link encoded in the QR — the we-meet Android app handles this scheme. */
export const qrDeepLink = (token: string): string =>
  `we-meet://qr-login?token=${encodeURIComponent(token)}`
