import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchImToken } from './fetchImToken'
import { hideConversation } from './hideConversation'

vi.mock('./fetchImToken', () => ({
  fetchImToken: vi.fn(),
}))

describe('hideConversation', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_JUSI_IM_BASE_URL', 'https://im.example.test/')
    vi.mocked(fetchImToken).mockResolvedValue({
      uid: 'me',
      token: 'jwt-token',
      ws_url: 'wss://im.example.test/v1/ws',
      expires_at: Date.now() + 60_000,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('soft-hides an encoded conversation id with a fresh IM token', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await hideConversation('group/a')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://im.example.test/v1/conversations/group%2Fa/hide',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer jwt-token' },
      }
    )
  })

  it('surfaces a failed hide response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not a member', { status: 404 }))
    )

    await expect(hideConversation('group-1')).rejects.toThrow(
      'hideConversation failed (404): not a member'
    )
  })
})
