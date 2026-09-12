import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi, fetchApiBlob } from './fetchApi'

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

  it('keeps binary responses bounded even without a content length', async () => {
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(8) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(8) }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: {
          get: (name: string) => (name === 'Content-Type' ? 'audio/wav' : null),
        },
        body: { getReader: () => reader },
      }))
    )
    await expect(fetchApiBlob('capture-audio/', {}, 10)).rejects.toThrow(
      'audio_download_too_large'
    )
    expect(reader.cancel).toHaveBeenCalledTimes(1)
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('returns a small binary response without JSON conversion', async () => {
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(8) })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: {
          get: (name: string) => (name === 'Content-Type' ? 'audio/wav' : null),
        },
        body: { getReader: () => reader },
      }))
    )
    const blob = await fetchApiBlob('capture-audio/', {}, 10)
    expect(blob.size).toBe(8)
    expect(blob.type).toBe('audio/wav')
    expect(reader.cancel).not.toHaveBeenCalled()
  })
})
