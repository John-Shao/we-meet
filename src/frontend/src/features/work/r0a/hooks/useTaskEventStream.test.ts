import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openWorkEventStream, WorkApiError } from '../api/client'
import {
  MAX_LIVE_EVENTS,
  MAX_SEEN_EVENTS,
  MAX_SSE_FRAME_CHARS,
  parseSseFrames,
  useTaskEventStream,
} from './useTaskEventStream'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  openWorkEventStream: vi.fn(),
}))

describe('parseSseFrames', () => {
  it('parses ids, event types, comments and multiline data', () => {
    const parsed = parseSseFrames(
      ': ping\n\n' +
        'id: e1\nevent: task.updated\ndata: {"event_id":"e1",\n' +
        'data: "type":"task.updated"}\n\n' +
        'retry: 5000\n\n' +
        'id: e2\nevent: artifact.published\ndata: {"event_id":"e2"}\n\n'
    )
    expect(parsed.frames).toHaveLength(2)
    expect(parsed.frames[0]).toEqual({
      id: 'e1',
      event: 'task.updated',
      data: '{"event_id":"e1",\n"type":"task.updated"}',
    })
    expect(parsed.frames[1]).toEqual({
      id: 'e2',
      event: 'artifact.published',
      data: '{"event_id":"e2"}',
    })
    expect(parsed.rest).toBe('')
  })

  it('keeps an incomplete trailing frame for the next chunk', () => {
    const parsed = parseSseFrames(
      'id: e1\ndata: {"event_id":"e1"}\n\nid: e2\ndata:'
    )
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.rest).toBe('id: e2\ndata:')
  })
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const frame = (id: string, cursor = id, taskId = 'task-a') =>
  `id: ${cursor}\ndata: ${JSON.stringify({
    event_id: id,
    task_id: taskId,
    seq: 1,
    type: 'task.updated',
    payload: {},
  })}\n\n`

const stream = () => {
  let source!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
    })
  )
  return {
    response,
    send: (text: string) => source.enqueue(new TextEncoder().encode(text)),
    close: () => source.close(),
  }
}

const open = vi.mocked(openWorkEventStream)
const flush = () => act(async () => {})
const retry = (ms = 1_000) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

describe('useTaskEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    open.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('starts after the snapshot and keeps its cursor across refreshes and disconnects', async () => {
    const first = stream()
    const second = stream()
    open
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
    const resync = vi.fn<() => Promise<string | null>>()
    const { result, rerender } = renderHook(
      ({ enabled, cursor }) =>
        useTaskEventStream('task-a', enabled, resync, cursor),
      { initialProps: { enabled: false, cursor: 'snapshot-1' } }
    )
    expect(open).not.toHaveBeenCalled()
    rerender({ enabled: true, cursor: 'snapshot-1' })
    await flush()
    expect(open.mock.calls[0][2]).toBe('snapshot-1')
    rerender({ enabled: true, cursor: 'unrelated-newer-snapshot' })
    await act(async () => {
      first.close()
    })
    expect(result.current.status).toBe('reconnecting')
    await retry()
    expect(open.mock.calls[1][2]).toBe('snapshot-1')
    await act(async () => {
      second.send(frame('between-snapshot-and-stream'))
    })
    expect(result.current.events.map((event) => event.event_id)).toEqual([
      'between-snapshot-and-stream',
    ])
    expect(resync).not.toHaveBeenCalled()
  })

  it.each(['response', 'exception'] as const)(
    'awaits fresh resync, ignoring the 409 header (%s)',
    async (kind) => {
      const snapshot = deferred<string | null>()
      const resync = vi.fn().mockReturnValue(snapshot.promise)
      const resumed = stream()
      if (kind === 'response') {
        open.mockResolvedValueOnce(
          new Response(null, {
            status: 409,
            headers: { 'X-Work-Event-Cursor': 'unsafe-header' },
          })
        )
      } else {
        open.mockRejectedValueOnce(
          new WorkApiError(409, { code: 'resync_required' })
        )
      }
      open.mockResolvedValueOnce(resumed.response)
      const { result } = renderHook(() =>
        useTaskEventStream('task-a', true, resync, 'expired')
      )
      await flush()
      expect(resync).toHaveBeenCalledTimes(1)
      await retry(60_000)
      expect(open).toHaveBeenCalledTimes(1)
      expect(result.current.status).toBe('reconnecting')
      await act(async () => {
        snapshot.resolve('fresh-snapshot')
      })
      await retry()
      expect(open.mock.calls[1][2]).toBe('fresh-snapshot')
      await act(async () => {
        resumed.send(frame('gap-event', 'opaque-gap-cursor'))
      })
      expect(result.current.events[0].event_id).toBe('gap-event')
    }
  )

  it('retries failed or cursorless snapshots before opening another stream', async () => {
    const resync = vi
      .fn()
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('recovered-snapshot')
    open
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(stream().response)
    renderHook(() => useTaskEventStream('task-a', true, resync, 'expired'))
    await flush()
    expect(resync).toHaveBeenCalledTimes(1)
    await retry()
    expect(resync).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(1)
    await retry(2_000)
    expect(resync).toHaveBeenCalledTimes(3)
    expect(open.mock.calls[1][2]).toBe('recovered-snapshot')
  })

  it('does not start an unanchored stream when the initial snapshot lacks a cursor', async () => {
    const snapshot = deferred<string | null>()
    open.mockResolvedValue(stream().response)
    renderHook(() =>
      useTaskEventStream('task-a', true, () => snapshot.promise, null)
    )
    await flush()
    expect(open).not.toHaveBeenCalled()
    await act(async () => {
      snapshot.resolve('initial-fresh')
    })
    expect(open.mock.calls[0][2]).toBe('initial-fresh')
  })

  it('deduplicates reconnect replay, advances opaque cursors, and clears dedup on resync', async () => {
    const first = stream()
    const replay = stream()
    const fresh = stream()
    open
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(replay.response)
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(fresh.response)
    const { result } = renderHook(() =>
      useTaskEventStream('task-a', true, async () => 'fresh', 'initial')
    )
    await flush()
    await act(async () => {
      first.send(frame('e1', 'opaque-1'))
      first.close()
    })
    await retry()
    expect(open.mock.calls[1][2]).toBe('opaque-1')
    await act(async () => {
      replay.send(frame('e1', 'opaque-replay'))
      replay.close()
    })
    expect(result.current.events).toHaveLength(1)
    await retry()
    expect(open.mock.calls[2][2]).toBe('opaque-replay')
    expect(result.current.events).toEqual([])
    await retry(2_000)
    await act(async () => {
      fresh.send(frame('e1', 'fresh-event'))
    })
    expect(result.current.events).toHaveLength(1)
  })

  it('bounds the live timeline and dedup window', async () => {
    const live = stream()
    open.mockResolvedValue(live.response)
    const { result } = renderHook(() =>
      useTaskEventStream('task-a', true, async () => 'fresh', 'initial')
    )
    await flush()
    await act(async () => {
      live.send(
        Array.from({ length: MAX_SEEN_EVENTS + 2 }, (_, i) =>
          frame(`e${i}`)
        ).join('')
      )
    })
    expect(result.current.events).toHaveLength(MAX_LIVE_EVENTS)
    const last = result.current.events.at(-1)!.event_id
    await act(async () => {
      live.send(frame(last))
    })
    expect(result.current.events.at(-1)!.event_id).toBe(last)
    await act(async () => {
      live.send(frame('e0'))
    })
    expect(result.current.events).toHaveLength(MAX_LIVE_EVENTS)
    expect(result.current.events.at(-1)!.event_id).toBe('e0')
  })

  it('resyncs instead of retaining an oversized incomplete frame', async () => {
    const live = stream()
    const snapshot = deferred<string | null>()
    const resync = vi.fn().mockReturnValue(snapshot.promise)
    open.mockResolvedValue(live.response)
    const { result } = renderHook(() =>
      useTaskEventStream('task-a', true, resync, 'initial')
    )
    await flush()
    await act(async () => {
      live.send('data: ' + 'x'.repeat(MAX_SSE_FRAME_CHARS + 1))
    })
    expect(resync).toHaveBeenCalledTimes(1)
    expect(result.current.events).toEqual([])
    expect(open.mock.calls[0][1].aborted).toBe(true)
    expect(() => live.send('more data')).toThrow()
    await retry(60_000)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404])('stops reconnecting on HTTP %s', async (status) => {
    open.mockResolvedValue(
      new Response(JSON.stringify({ code: 'denied' }), { status })
    )
    const { result } = renderHook(() =>
      useTaskEventStream('task-a', true, async () => 'fresh', 'initial')
    )
    await flush()
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('denied')
    await retry(60_000)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it.each(['fetch', 'read', 'resync', 'error-body'] as const)(
    'ignores a late %s after switching tasks and unmounting',
    async (stage) => {
      const pending = deferred<Response>()
      const read = deferred<ReadableStreamReadResult<Uint8Array>>()
      const snapshot = deferred<string | null>()
      const json = deferred<{ code: string }>()
      const cancel = vi.fn().mockResolvedValue(undefined)
      const resync = vi.fn().mockReturnValue(snapshot.promise)
      if (stage === 'fetch') open.mockReturnValueOnce(pending.promise)
      if (stage === 'read')
        open.mockResolvedValueOnce({
          ok: true,
          body: { getReader: () => ({ read: () => read.promise, cancel }) },
        } as unknown as Response)
      if (stage === 'resync')
        open.mockResolvedValueOnce(new Response(null, { status: 409 }))
      if (stage === 'error-body')
        open.mockResolvedValueOnce({
          ok: false,
          status: 403,
          json: () => json.promise,
        } as unknown as Response)
      const next = stream()
      open.mockResolvedValueOnce(next.response)
      const { result, rerender, unmount } = renderHook(
        ({ taskId }) =>
          useTaskEventStream(taskId, true, resync, `${taskId}-snapshot`),
        { initialProps: { taskId: 'task-a' } }
      )
      await flush()
      const oldSignal = open.mock.calls[0][1]
      rerender({ taskId: 'task-b' })
      await flush()
      expect(oldSignal.aborted).toBe(true)
      await act(async () => {
        pending.resolve(new Response(null, { status: 409 }))
        read.resolve({
          done: false,
          value: new TextEncoder().encode(frame('late-a')),
        })
        snapshot.resolve('late-a-snapshot')
        json.resolve({ code: 'late-denial' })
      })
      expect(result.current.status).toBe('open')
      expect(result.current.error).toBeNull()
      expect(result.current.events).toEqual([])
      await act(async () => {
        next.send(frame('b-event', 'b-cursor', 'task-b'))
      })
      expect(result.current.events[0].event_id).toBe('b-event')
      unmount()
      await retry(60_000)
      expect(open).toHaveBeenCalledTimes(2)
      expect(resync).toHaveBeenCalledTimes(stage === 'resync' ? 1 : 0)
    }
  )

  it('ignores a resync resolving after unmount and cancels retry timers', async () => {
    const snapshot = deferred<string | null>()
    open.mockResolvedValue(new Response(null, { status: 409 }))
    const { unmount } = renderHook(() =>
      useTaskEventStream('task-a', true, () => snapshot.promise, 'initial')
    )
    await flush()
    unmount()
    await act(async () => {
      snapshot.resolve('late')
    })
    await retry(60_000)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
