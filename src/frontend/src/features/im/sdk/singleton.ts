import { Client, type ClientOptions } from '@jusi/light-im-sdk'

import { fetchImToken } from '../api/fetchImToken'

let singletonClient: Client | null = null

/**
 * Singleton SDK Client. Lazily constructed on first call; reused across mounts.
 *
 * baseURL comes from VITE_JUSI_IM_BASE_URL (set at build time per env). The
 * /im/token bridge also returns `ws_url`; today we only use it for the diagnostic
 * banner — switching the endpoint at runtime needs a Client teardown + rebuild.
 *
 * Token is always fetched via we-meet's /api/v1.0/im/token (OIDC bearer auto-attached).
 */
export const getImClient = (): Client => {
  if (singletonClient) return singletonClient

  const baseURL =
    (import.meta.env.VITE_JUSI_IM_BASE_URL as string | undefined) ?? ''

  if (!baseURL) {
    throw new Error(
      'VITE_JUSI_IM_BASE_URL is not configured — jusi-light-im integration disabled',
    )
  }

  const opts: ClientOptions = {
    baseURL,
    tokenProvider: async () => {
      const t = await fetchImToken()
      return t.token
    },
    backoff: { baseMs: 1000, maxMs: 30000, factor: 2, jitter: 0.3 },
  }
  singletonClient = new Client(opts)
  return singletonClient
}

/** Tear down the singleton — call from auth-logout flows so the next login starts fresh. */
export const resetImClient = (): void => {
  if (singletonClient) {
    try {
      singletonClient.disconnect()
    } catch {
      // ignore
    }
    singletonClient = null
  }
}
