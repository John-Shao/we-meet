import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskWorkspacePage } from './TaskWorkspacePage'
import { fetchWorkTask, openWorkEventStream } from '../api/client'
import type { WorkTaskDetail } from '../api/types'

const route = vi.hoisted(() => ({ taskId: 'task-a' }))
vi.mock('wouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wouter')>()),
  useParams: () => route,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchWorkTask: vi.fn(),
  openWorkEventStream: vi.fn(),
}))
vi.mock('../components/ArtifactPanel', () => ({
  ArtifactPanel: ({ artifactId }: { artifactId: string }) => (
    <div>Artifact {artifactId}</div>
  ),
}))

const detail = (cursor: string, taskId = 'task-a'): WorkTaskDetail => ({
  summary: {
    task_id: taskId,
    title: `${taskId} ${cursor}`,
    display_state: 'running',
    task_state: 'open',
    permission_mode: 'ask_each',
    active_run_id: null,
    latest_run_id: null,
    latest_run: null,
    latest_artifact: null,
    revision: 1,
    pending_acceptance: false,
    blocking_operations: 0,
    quota: { reserved_tokens: 1000, settled_tokens: 0 },
    created_at: '2026-10-29T00:00:00Z',
    updated_at: '2026-10-29T00:00:00Z',
  },
  input_ref: 'input',
  goal: 'Test goal',
  background: null,
  template: null,
  snapshot: null,
  latest_event_id: cursor,
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const tick = (ms = 20) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const stubViewport = (readOnly: boolean) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: readOnly,
    media: '(max-width: 767px)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}
const acceptanceDetail = (
  cursor: string,
  withArtifact = true
): WorkTaskDetail => {
  const value = detail(cursor)
  value.summary.task_state = 'awaiting_acceptance'
  value.summary.display_state = 'awaiting_acceptance'
  if (withArtifact) {
    value.summary.latest_artifact = {
      artifact_id: 'final-artifact',
      version_no: 1,
      content_hash: 'hash',
    }
  }
  return value
}
const runningDetail = (cursor: string): WorkTaskDetail => {
  const value = detail(cursor)
  value.summary.latest_run = {
    id: 'run-a',
    task_id: 'task-a',
    attempt_no: 1,
    state: 'active',
    wait_reason: null,
    terminal_reason: null,
    control_revision: 1,
    runtime_version: 'test',
    created_at: '2026-10-29T00:00:00Z',
    updated_at: '2026-10-29T00:00:00Z',
  }
  return value
}
const fetchTask = vi.mocked(fetchWorkTask)
const open = vi.mocked(openWorkEventStream)
const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <TaskWorkspacePage />
    </QueryClientProvider>
  )
  return { ...view, client }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  fetchTask.mockReset()
  open.mockReset()
  route.taskId = 'task-a'
  stubViewport(false)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('TaskWorkspacePage snapshot/stream integration', () => {
  it('waits for the exact fresh snapshot, cancels a pre-409 query, and sees a final event in the reconnect gap', async () => {
    const initial = deferred<WorkTaskDetail>()
    const oldRefresh = deferred<WorkTaskDetail>()
    const fresh = deferred<WorkTaskDetail>()
    const expired = deferred<Response>()
    const completed = detail('final-cursor')
    completed.summary.task_state = 'awaiting_acceptance'
    completed.summary.display_state = 'awaiting_acceptance'
    completed.summary.latest_artifact = {
      artifact_id: 'final-artifact',
      version_no: 1,
      content_hash: 'hash',
    }
    fetchTask
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(oldRefresh.promise)
      .mockReturnValueOnce(fresh.promise)
      .mockResolvedValue(completed)
    let source!: ReadableStreamDefaultController<Uint8Array>
    open.mockReturnValueOnce(expired.promise).mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            source = controller
          },
        })
      )
    )
    const { client } = setup()
    await tick()
    expect(open).not.toHaveBeenCalled()
    await act(async () => {
      initial.resolve(detail('initial-cursor'))
    })
    await tick()
    expect(open.mock.calls[0][2]).toBe('initial-cursor')

    void client.invalidateQueries({ queryKey: ['work', 'task', 'task-a'] })
    await tick()
    expect(fetchTask).toHaveBeenCalledTimes(2)
    await act(async () => {
      expired.resolve(
        new Response(null, {
          status: 409,
          headers: { 'X-Work-Event-Cursor': 'unsafe-header' },
        })
      )
    })
    await tick()
    expect(fetchTask).toHaveBeenCalledTimes(3)
    await tick(5_000)
    expect(open).toHaveBeenCalledTimes(1)
    await act(async () => {
      fresh.resolve(detail('fresh-cursor'))
    })
    await tick()
    expect(
      screen.getByRole('heading', { name: 'task-a fresh-cursor' })
    ).toBeInTheDocument()
    await act(async () => {
      oldRefresh.resolve(detail('stale-cursor'))
    })
    await tick()
    expect(
      client.getQueryData<WorkTaskDetail>(['work', 'task', 'task-a'])
        ?.latest_event_id
    ).toBe('fresh-cursor')
    await tick(1_000)
    expect(open.mock.calls[1][2]).toBe('fresh-cursor')
    await act(async () => {
      source.enqueue(
        new TextEncoder().encode(
          `id: final-cursor\ndata: ${JSON.stringify({
            event_id: 'gap-event',
            task_id: 'task-a',
            type: 'artifact.published',
            seq: 2,
            occurred_at: '2026-10-29T00:00:01Z',
            payload: {},
          })}\n\n`
        )
      )
    })
    await tick()
    expect(screen.getByText('Artifact final-artifact')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'task.confirmAcceptArtifact' })
    ).toBeInTheDocument()
    expect(open.mock.calls[1][1].aborted).toBe(true)
  })

  it('retries a failed detail fetch before reconnecting, even with cached data', async () => {
    fetchTask
      .mockResolvedValueOnce(detail('cached-cursor'))
      .mockRejectedValueOnce(new Error('snapshot offline'))
      .mockResolvedValueOnce(detail('recovered-cursor'))
    open
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(new ReadableStream()))
    setup()
    await tick()
    expect(fetchTask).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(1)
    await tick(1_000)
    expect(fetchTask).toHaveBeenCalledTimes(3)
    expect(open.mock.calls[1][2]).toBe('recovered-cursor')
    expect(
      screen.getByRole('heading', { name: 'task-a recovered-cursor' })
    ).toBeInTheDocument()
  })

  it('does not reopen the stream when the resync snapshot is terminal', async () => {
    const terminal = detail('completed-cursor')
    terminal.summary.task_state = 'completed'
    fetchTask
      .mockResolvedValueOnce(detail('old'))
      .mockResolvedValueOnce(terminal)
    open.mockResolvedValueOnce(new Response(null, { status: 409 }))
    setup()
    await tick(5_000)
    expect(
      screen.getByRole('heading', { name: 'task-a completed-cursor' })
    ).toBeInTheDocument()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('keeps task B visible when task A resync resolves after navigation', async () => {
    const old = deferred<WorkTaskDetail>()
    fetchTask
      .mockResolvedValueOnce(detail('a-initial'))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(detail('b-initial', 'task-b'))
    open
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(new ReadableStream()))
    const { client, rerender } = setup()
    await tick()
    expect(fetchTask).toHaveBeenCalledTimes(2)
    route.taskId = 'task-b'
    rerender(
      <QueryClientProvider client={client}>
        <TaskWorkspacePage />
      </QueryClientProvider>
    )
    await tick()
    expect(open.mock.calls[1][0]).toBe('task-b')
    expect(open.mock.calls[1][2]).toBe('b-initial')
    await act(async () => {
      old.resolve(detail('a-late'))
    })
    await tick(5_000)
    expect(
      screen.getByRole('heading', { name: 'task-b b-initial' })
    ).toBeInTheDocument()
    expect(screen.queryByText('task-a a-late')).not.toBeInTheDocument()
    expect(open).toHaveBeenCalledTimes(2)
  })
})

describe('TaskWorkspacePage read-only viewport', () => {
  it('hides title, cancel and artifact acceptance controls below 768px while keeping the timeline and artifact', async () => {
    stubViewport(true)
    fetchTask.mockResolvedValueOnce(acceptanceDetail('acceptance'))
    setup()
    await tick()
    expect(screen.getByText('readOnly.taskNotice')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'task-a acceptance' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.editTitle' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.cancelRun' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.confirmAcceptArtifact' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.confirmAccept' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('task.acceptTitle')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'task.timeline' })
    ).toBeInTheDocument()
    expect(screen.getByText('event.task.submitted')).toBeInTheDocument()
    expect(screen.getByText('Artifact final-artifact')).toBeInTheDocument()
  })

  it('hides the complete-by-reason acceptance path below 768px', async () => {
    stubViewport(true)
    fetchTask.mockResolvedValueOnce(acceptanceDetail('no-artifact', false))
    setup()
    await tick()
    expect(screen.getByText('readOnly.taskNotice')).toBeInTheDocument()
    expect(screen.queryByLabelText('task.acceptReason')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.confirmAccept' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('task.acceptTitle')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'task.timeline' })
    ).toBeInTheDocument()
  })

  it('hides run cancellation below 768px', async () => {
    stubViewport(true)
    fetchTask.mockResolvedValueOnce(runningDetail('running'))
    open.mockResolvedValueOnce(new Response(null, { status: 503 }))
    setup()
    await tick()
    expect(screen.getByText('readOnly.taskNotice')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.cancelRun' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'task.editTitle' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'task.timeline' })
    ).toBeInTheDocument()
  })

  it('hides the task-load retry below 768px', async () => {
    stubViewport(true)
    fetchTask.mockRejectedValueOnce(new Error('offline'))
    setup()
    await tick()
    expect(screen.getByText('task.loadErrorTitle')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'retry' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'task.back' })
    ).toBeInTheDocument()
  })

  it('keeps edit and cancel controls at 768px and above', async () => {
    stubViewport(false)
    fetchTask.mockResolvedValueOnce(runningDetail('wide-running'))
    open.mockResolvedValueOnce(new Response(null, { status: 503 }))
    setup()
    await tick()
    expect(
      screen.getByRole('button', { name: 'task.editTitle' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'task.cancelRun' })
    ).toBeInTheDocument()
    expect(screen.queryByText('readOnly.taskNotice')).not.toBeInTheDocument()
  })

  it('keeps artifact acceptance at 768px and above', async () => {
    stubViewport(false)
    fetchTask.mockResolvedValueOnce(acceptanceDetail('wide-acceptance'))
    setup()
    await tick()
    expect(
      screen.getByRole('button', { name: 'task.editTitle' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'task.confirmAcceptArtifact' })
    ).toBeInTheDocument()
    expect(screen.queryByText('readOnly.taskNotice')).not.toBeInTheDocument()
  })

  it('renders the closed snapshot as a revision and a localized permission mode', async () => {
    const withSnapshot = acceptanceDetail('snapshot-panel')
    withSnapshot.snapshot = {
      snapshot_id: 'snap-1',
      snapshot_revision: 2,
      template: { id: 'summary', version: 1, content_hash: 'hash' },
      limits: { token_upper_bound: 100_000 },
      permission_mode: 'ask_each',
      created_at: '2026-10-30T00:00:00Z',
    }
    fetchTask.mockResolvedValueOnce(withSnapshot)
    setup()
    await tick()
    expect(screen.getByText('v2')).toBeInTheDocument()
    expect(screen.getByText('composer.mode.ask_each')).toBeInTheDocument()
    expect(screen.queryByText('ask_each')).not.toBeInTheDocument()
  })
})
