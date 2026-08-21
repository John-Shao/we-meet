import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sseStream } from './sseStream'

vi.mock('@/features/auth/api/mobileOtp', () => ({
  refreshTokens: vi.fn(),
}))

const unauthorizedResponse = (): Response =>
  ({ status: 401, ok: false }) as Response

const eventStreamResponse = (...frames: string[]): Response => {
  const chunks = frames.map((frame) => new TextEncoder().encode(frame))
  let index = 0
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn().mockImplementation(async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined }
        ),
      }),
    },
  } as unknown as Response
}

describe('sseStream authentication fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.setItem('we-meet:access_token', 'expired-access-token')
  })

  it('retries with the session cookie when a stored bearer is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce(
        eventStreamResponse('data: {"type":"done"}\n\n')
      )
    vi.stubGlobal('fetch', fetchMock)

    const events = []
    for await (const event of sseStream('users/me/ai/ask-stream/', {
      body: { question: 'test' },
    })) {
      events.push(event)
    }

    expect(events).toEqual([{ type: 'done' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >
    const fallbackHeaders = fetchMock.mock.calls[1][1]?.headers as Record<
      string,
      string
    >
    expect(firstHeaders.Authorization).toBe('Bearer expired-access-token')
    expect(fallbackHeaders.Authorization).toBeUndefined()
    expect(fetchMock.mock.calls[1][1]?.credentials).toBe('include')
    expect(localStorage.getItem('we-meet:access_token')).toBeNull()
  })
})
