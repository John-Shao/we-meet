import { beforeEach, describe, expect, it, vi } from 'vitest'

import enWork from '@/locales/en/work.json'
import {
  createWorkInput,
  fetchWorkArtifactContent,
  fetchWorkArtifactWorkspace,
  fetchWorkBootstrap,
  fetchWorkInbox,
  fetchWorkRunOperations,
  setWorkCSRFToken,
  WorkApiError,
  workErrorMessage,
  workTaskArtifactContentUrl,
} from './client'

// A real Response carries a Headers object, and the generated client reads the response headers
// into a plain record; a stub with only get() would fail on that. Keeping the real Headers here
// makes the fixture answer the same way the browser does.
// A real Response answers both text() and json(), and the generated client reads the body once as
// text and parses it when the content type says JSON, so the stubs have to carry both.

// Walks a dotted i18n key into the loaded resource object, mirroring what t() resolves.
// A key that is not present in the catalog yields undefined, which is the false-green
// this guard exists to catch: workErrorMessage must return a key the locales define.
const resolveKey = (key: string): string | undefined =>
  key
    .split('.')
    .reduce<Record<string, unknown> | string | undefined>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      enWork as unknown as Record<string, unknown>
    ) as string | undefined

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as Response

const textResponse = (body: string, contentType: string): Response =>
  ({
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': contentType }),
    json: vi.fn().mockRejectedValue(new TypeError('not json')),
    text: vi.fn().mockResolvedValue(body),
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
    // Bootstrap first, then the refused mutation: the assertion below is about how a server refusal
    // reaches the app, so the 409 has to come from the mutation rather than from the session read.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { csrf_token: 'csrf-err' }))
        .mockResolvedValueOnce(
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

  it('reads artifact content with disposition and media type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        textResponse('# 成果\n\n正文', 'text/markdown; charset=utf-8')
      )
    vi.stubGlobal('fetch', fetchMock)

    const content = await fetchWorkArtifactContent('task-1', 'artifact-1', 2)
    expect(content).toEqual({
      text: '# 成果\n\n正文',
      mediaType: 'text/markdown',
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/work/v1/tasks/task-1/artifacts/artifact-1/versions/2/content?disposition=inline'
    )
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin')
    expect(
      workTaskArtifactContentUrl('task-1', 'artifact-1', 2, 'attachment')
    ).toBe(
      '/work/v1/tasks/task-1/artifacts/artifact-1/versions/2/content?disposition=attachment'
    )
  })

  it('reads the inbox and the run operation ledger', async () => {
    const inboxPayload = {
      items: [
        {
          task_id: 'task-1',
          type: 'acceptance_required',
          title: 'Task',
          display_state: 'awaiting_acceptance',
          updated_at: '2026-11-02T10:00:00Z',
        },
      ],
      next_cursor: 'cursor-2',
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, inboxPayload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchWorkInbox()).resolves.toEqual(inboxPayload)
    expect(fetchMock.mock.calls[0][0]).toBe('/work/v1/inbox?limit=20')
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin')
    // A GET must never carry the CSRF header.
    // The generated client hands fetch a plain header record, so read it through Headers - the
    // same idiom the CSRF assertion above already uses.
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get('X-CSRF-Token')
    ).toBeNull()

    await fetchWorkInbox('cursor-2')
    // The order is the contract's: the generated client appends query params in the order
    // r0a-openapi-v1.yaml declares them (listInbox is [cursor, limit]), where the hand-written
    // client had put limit first. The server reads them by name, so only the string changes.
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/work/v1/inbox?cursor=cursor-2&limit=20'
    )

    const operationsPayload = {
      items: [
        {
          id: 'op-1',
          run_id: 'run-1',
          logical_key: 'model:1',
          kind: 'model',
          state: 'dispatching',
          request_hash: 'sha256:req',
          provider_request_id: null,
          receipt_ref: null,
          revision: 0,
          created_at: '2026-11-02T10:00:00Z',
          updated_at: '2026-11-02T10:00:05Z',
        },
      ],
      next_cursor: null,
    }
    fetchMock.mockResolvedValue(jsonResponse(200, operationsPayload))
    await expect(fetchWorkRunOperations('run-1')).resolves.toEqual(
      operationsPayload
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      '/work/v1/runs/run-1/operations?limit=20'
    )
  })

  it('reads the task-scoped artifact workspace with versions', async () => {
    const payload = {
      summary: { task_id: 'task-1', title: 'Task' },
      artifact: {
        artifact_id: 'artifact-1',
        logical_name: 'result',
        state: 'published',
        revision: 0,
        created_at: '2026-10-31T00:00:00Z',
        updated_at: '2026-10-31T00:00:00Z',
        accepted_version_no: 1,
        versions: [
          {
            version_no: 1,
            media_type: 'text/markdown',
            bytes: 12,
            content_hash: 'sha256:hash',
            state: 'published',
            content_url:
              '/work/v1/tasks/task-1/artifacts/artifact-1/versions/1/content',
            created_at: '2026-10-31T00:00:00Z',
            published_at: '2026-10-31T00:00:00Z',
          },
        ],
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    const workspace = await fetchWorkArtifactWorkspace('task-1', 'artifact-1')
    expect(workspace).toEqual(payload)
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/work/v1/tasks/task-1/artifacts/artifact-1'
    )
  })

  it('maps artifact content errors to WorkApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          code: 'artifact_not_found',
          message: 'not found',
          correlation_id: 'corr-2',
        })
      )
    )
    await expect(
      fetchWorkArtifactContent('task-1', 'artifact-1', 1)
    ).rejects.toMatchObject({
      code: 'artifact_not_found',
      status: 404,
      correlationId: 'corr-2',
    } satisfies Partial<WorkApiError>)
  })

  it('returns i18n keys for errors, and every key resolves in the locale catalog', () => {
    const resync = new WorkApiError(410, {
      code: 'resync_required',
      message: '事件游标已过期，请重新同步。',
    })
    const conflict = new WorkApiError(409, {
      code: 'version_conflict',
      message: '版本已变更',
    })
    expect(workErrorMessage(resync)).toBe('errors.resyncRequired')
    expect(workErrorMessage(conflict)).toBe('errors.generic')
    expect(workErrorMessage(new Error('network'))).toBe('errors.generic')
    expect(workErrorMessage('a string')).toBe('errors.generic')
    // Regression guard: the returned keys must exist in en/work.json, otherwise t()
    // silently renders the raw key and the server's Chinese text never reaches the UI.
    expect(resolveKey(workErrorMessage(resync))).toBeTypeOf('string')
    expect(resolveKey(workErrorMessage(conflict))).toBeTypeOf('string')
  })
})
