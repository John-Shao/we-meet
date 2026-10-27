import { afterEach, expect, it, vi } from 'vitest'
import type { WorkEvent } from '../contracts/sse'
import {
  createWorkApiClient,
  subscribeTaskEvents,
  WorkApiError,
} from './client'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

it('bootstraps the csrf token and sends it on mutations', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ csrf_token: 'csrf-123' }))
    .mockResolvedValueOnce(jsonResponse({ input_ref: 'input-1' }, 201))
  vi.stubGlobal('fetch', fetchMock)
  const client = createWorkApiClient()
  await client.getBootstrap()
  await client.createInput({ client_request_id: 'input-1', goal: 'g' })

  const [, init] = fetchMock.mock.calls[1]
  expect(fetchMock.mock.calls[1][0]).toBe('/work/v1/inputs')
  expect(init.credentials).toBe('include')
  expect((init.headers as Headers).get('X-CSRFToken')).toBe('csrf-123')
})

it('maps the public error envelope', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'idempotency_key_conflict',
          message: 'conflict',
          retryable: false,
          correlation_id: 'cid',
        },
        409
      )
    )
  )
  const client = createWorkApiClient()
  await expect(
    client.submitTask({} as Parameters<typeof client.submitTask>[0])
  ).rejects.toMatchObject({
    status: 409,
    code: 'idempotency_key_conflict',
    correlationId: 'cid',
    retryable: false,
  })
})

it('streams task events and reports 409 resync', async () => {
  const event = {
    event_id: 'e1',
    task_id: 't1',
    seq: 1,
    schema_version: 'work-event-v1',
    occurred_at: '2026-10-27T00:00:00Z',
    type: 'task.updated',
    payload: {},
  } satisfies WorkEvent
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `id: e1\nevent: task.updated\ndata: ${JSON.stringify(event)}\n\n`
        )
      )
      controller.close()
    },
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    .mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'resync_required',
          message: 'resync',
          retryable: false,
          correlation_id: 'cid',
        },
        409
      )
    )
  vi.stubGlobal('fetch', fetchMock)
  const received: WorkEvent[] = []
  const onResyncRequired = vi.fn()
  await subscribeTaskEvents('t1', {
    lastEventId: 'e0',
    onEvent: (item) => received.push(item),
    onResyncRequired,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(received[0].event_id).toBe('e1')
  expect(fetchMock.mock.calls[0][1].headers.get('Last-Event-ID')).toBe('e0')

  await expect(
    subscribeTaskEvents('t1', {
      onEvent: () => undefined,
      onResyncRequired,
    })
  ).rejects.toBeInstanceOf(WorkApiError)
  expect(onResyncRequired).toHaveBeenCalled()
})
