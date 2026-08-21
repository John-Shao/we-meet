import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from './fetchApi'

vi.mock('@/features/auth/api/mobileOtp', () => ({
  refreshTokens: vi.fn(),
}))

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response

describe('fetchApi authentication fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.setItem('we-meet:access_token', 'expired-access-token')
  })

  it('retries with the session cookie when a stored bearer is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'task-id' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchApi('tasks/', {
        method: 'POST',
        body: JSON.stringify({ title: 'Task' }),
      })
    ).resolves.toEqual({ id: 'task-id' })

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
