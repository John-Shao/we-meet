import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createWorkInput,
  fetchWorkBootstrap,
  setWorkCSRFToken,
  WorkApiError,
} from './client'

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response

describe('Work API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setWorkCSRFToken(null)
  })

  it('stores the bootstrap CSRF token and sends it on mutations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { csrf_token: 'csrf-1' }))
      .mockResolvedValueOnce(
        jsonResponse(201, { input_ref: 'input-1', content_hash: 'h', bytes: 2 })
      )
    vi.stubGlobal('fetch', fetchMock)

    await fetchWorkBootstrap()
    await createWorkInput({
      client_request_id: 'request-1',
      goal: 'goal',
      background: '',
    })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/work/v1/inputs')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-1')
    expect(JSON.parse(init.body)).toMatchObject({
      client_request_id: 'request-1',
      goal: 'goal',
    })
  })

  it('refreshes bootstrap once and retries a csrf_invalid mutation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { csrf_token: 'csrf-old' }))
      .mockResolvedValueOnce(jsonResponse(403, { code: 'csrf_invalid' }))
      .mockResolvedValueOnce(jsonResponse(200, { csrf_token: 'csrf-new' }))
      .mockResolvedValueOnce(jsonResponse(201, { input_ref: 'input-2' }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchWorkBootstrap()
    await createWorkInput({
      client_request_id: 'request-2',
      goal: 'goal',
      background: '',
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(
      new Headers(fetchMock.mock.calls[3][1].headers).get('X-CSRF-Token')
    ).toBe('csrf-new')
  })

  it('exposes the public error code and current revision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: 'version_conflict',
          message: 'version changed',
          current_revision: 7,
          correlation_id: 'corr',
        })
      )
    )
    await expect(
      createWorkInput({
        client_request_id: 'request-3',
        goal: 'goal',
        background: '',
      })
    ).rejects.toMatchObject({
      code: 'version_conflict',
      status: 409,
      currentRevision: 7,
      correlationId: 'corr',
    } satisfies Partial<WorkApiError>)
  })
})
