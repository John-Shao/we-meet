import { beforeEach, expect, it, vi } from 'vitest'
import { sseStream } from './sseStream'
import { refreshTokens } from '@/features/auth/api/mobileOtp'
import { setTokens } from '@/features/auth/utils/tokenStorage'
vi.mock('@/features/auth/api/mobileOtp', () => ({ refreshTokens: vi.fn() }))
beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(refreshTokens).mockReset()
  localStorage.clear()
})
it('never retries a paid question with a cookie identity', async () => {
  setTokens({ accessToken: 'old' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 401 }))
  )
  await expect(
    sseStream('users/me/ai/ask-stream/', { body: { question: 'test' } })
      [Symbol.asyncIterator]()
      .next()
  ).rejects.toMatchObject({ statusCode: 401 })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('refreshes the same session once and closes the consumed stream', async () => {
  setTokens({ accessToken: 'old', refreshToken: 'refresh' })
  vi.mocked(refreshTokens).mockResolvedValue({ access_token: 'fresh' })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValueOnce(new Response('data: {"type":"done"}\n\n'))
  vi.stubGlobal('fetch', fetchMock)
  const events = []
  for await (const event of sseStream('question/', { body: {} }))
    events.push(event)
  expect(events).toEqual([{ type: 'done' }])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(
    new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')
  ).toBe('Bearer fresh')
})
it('stops yielding buffered private events after an account switch', async () => {
  setTokens({ accessToken: 'old' })
  let canceled = false
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"delta","text":"first"}\n\ndata: {"type":"delta","text":"private"}\n\n'
        )
      )
    },
    cancel() {
      canceled = true
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream))
  )
  const iterator = sseStream('question/', { body: {} })[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({
    type: 'delta',
    text: 'first',
  })
  setTokens({ accessToken: 'different' })
  await expect(iterator.next()).rejects.toMatchObject({ statusCode: 401 })
  expect(canceled).toBe(true)
})
