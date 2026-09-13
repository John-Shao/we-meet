import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi, fetchApiBlob, attemptSilentRefresh } from './fetchApi'
import { refreshTokens } from '@/features/auth/api/mobileOtp'
import {
  setTokens,
  clearTokens,
  getAccessToken,
} from '@/features/auth/utils/tokenStorage'

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
    vi.mocked(refreshTokens).mockReset()
    localStorage.clear()
    localStorage.setItem('we-meet:access_token', 'expired-access-token')
  })

  it('does not retry source-bound mutations with a cookie identity', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { detail: 'Unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchApi('tasks/', { method: 'POST', body: '{}' })
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')
    ).toBe('Bearer expired-access-token')
  })
  it('allows cookie identity discovery only through users/me', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'cookie-user' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchApi('/users/me')).resolves.toEqual({ id: 'cookie-user' })
    expect(
      new Headers(fetchMock.mock.calls[1][1].headers).has('Authorization')
    ).toBe(false)
    expect(getAccessToken()).toBeNull()
  })
  it('does not refresh, clear or replay an old request after switching login', async () => {
    setTokens({ accessToken: 'old', refreshToken: 'old-refresh' })
    let respond!: (value: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const request = fetchApi('meeting-records/fixture/', {
      method: 'POST',
      body: '{}',
    })
    setTokens({ accessToken: 'new', refreshToken: 'new-refresh' })
    respond(jsonResponse(401, {}))
    await expect(request).rejects.toMatchObject({ statusCode: 401 })
    expect(refreshTokens).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBe('new')
  })
  it('does not resurrect credentials when a late refresh arrives after logout', async () => {
    setTokens({ accessToken: 'old', refreshToken: 'old-refresh' })
    let resolve!: (value: { access_token: string }) => void
    vi.mocked(refreshTokens).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = attemptSilentRefresh()
    clearTokens()
    resolve({ access_token: 'late' })
    await expect(pending).resolves.toBeNull()
    expect(getAccessToken()).toBeNull()
  })
  it('shares a refresh only within one login and preserves exact request body', async () => {
    setTokens({ accessToken: 'old', refreshToken: 'refresh' })
    let resolve!: (value: {
      access_token: string
      refresh_token: string
    }) => void
    vi.mocked(refreshTokens).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const fetchMock = vi.fn(async (_url, options) =>
      new Headers(options.headers).get('Authorization') === 'Bearer fresh'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, {})
    )
    vi.stubGlobal('fetch', fetchMock)
    const first = fetchApi('record/', {
      method: 'POST',
      body: '{"key":"original"}',
    })
    const second = fetchApi('record/')
    await vi.waitFor(() => expect(refreshTokens).toHaveBeenCalledTimes(1))
    resolve({ access_token: 'fresh', refresh_token: 'rotated' })
    await Promise.all([first, second])
    expect(
      fetchMock.mock.calls
        .filter(([, options]) => options.method === 'POST')
        .map(([, options]) => options.body)
    ).toEqual(['{"key":"original"}', '{"key":"original"}'])
  })
  it('does not share a pending old-account refresh with a new account', async () => {
    setTokens({ accessToken: 'old', refreshToken: 'old-refresh' })
    let old!: (value: { access_token: string }) => void
    vi.mocked(refreshTokens)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            old = resolve
          })
      )
      .mockResolvedValueOnce({ access_token: 'new-fresh' })
    const pending = attemptSilentRefresh()
    setTokens({ accessToken: 'new', refreshToken: 'new-refresh' })
    await expect(attemptSilentRefresh()).resolves.toBe('new-fresh')
    old({ access_token: 'late-old' })
    await expect(pending).resolves.toBeNull()
    expect(getAccessToken()).toBe('new-fresh')
  })
  it('rejects a late successful response after login changes', async () => {
    let done!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            done = resolve
          })
      )
    )
    const pending = fetchApi('private-record/')
    setTokens({ accessToken: 'different' })
    done(jsonResponse(200, { text: 'private' }))
    await expect(pending).rejects.toMatchObject({ statusCode: 401 })
  })
  it('never replaces explicit caller authorization during a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, {}))
    )
    await expect(
      fetchApi('guest/', {
        headers: new Headers({ Authorization: 'Bearer guest' }),
      })
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(refreshTokens).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
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
