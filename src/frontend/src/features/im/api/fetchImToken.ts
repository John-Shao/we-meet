import { fetchApi } from '@/api/fetchApi'

import type { ImTokenResponse } from './ApiIm'

/**
 * Calls POST /api/v1.0/im/token. Uses the shared fetchApi so the OIDC Bearer
 * is attached automatically and 401s trigger one silent refresh.
 *
 * Caller convention: invoke whenever the SDK asks for a fresh token via its
 * `tokenProvider` callback. Successive calls bypass any local caching — the
 * SDK does its own.
 */
export const fetchImToken = (): Promise<ImTokenResponse> =>
  fetchApi<ImTokenResponse>('/im/token/', { method: 'POST' })
