import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskWorkspacePage } from './TaskWorkspacePage'
import { fetchWorkTask, retryWorkTask } from '../api/client'
import type { WorkTaskDetail } from '../api/types'

vi.mock('wouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wouter')>()),
  useParams: () => ({ taskId: 'task-a' }),
  useLocation: () => ['/', () => {}],
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchWorkTask: vi.fn(),
  openWorkEventStream: vi.fn(),
  retryWorkTask: vi.fn(),
}))
vi.mock('../components/ArtifactPanel', () => ({
  ArtifactPanel: () => <div>Artifact</div>,
}))

const detailFor = (displayState: string): WorkTaskDetail => ({
  summary: {
    task_id: 'task-a',
    title: 'Retry me',
    display_state: displayState,
    task_state: displayState,
    permission_mode: 'ask_each',
    active_run_id: null,
    latest_run_id: null,
    latest_run: null,
    latest_artifact: null,
    revision: 7,
    pending_acceptance: false,
    blocking_operations: 0,
    quota: { reserved_tokens: 0, settled_tokens: 0 },
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  },
  input_ref: 'input',
  goal: 'Test goal',
  background: null,
  template: null,
  snapshot: null,
  latest_event_id: 'cursor-1',
})

const fetchTask = vi.mocked(fetchWorkTask)
const retry = vi.mocked(retryWorkTask)

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return render(
    <QueryClientProvider client={client}>
      <TaskWorkspacePage />
    </QueryClientProvider>
  )
}

const settle = async () => {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  fetchTask.mockReset()
  retry.mockReset()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '(max-width: 767px)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('task workspace retry affordance', () => {
  it('offers retry for the terminal states the matrix marks it primary in', async () => {
    fetchTask.mockResolvedValue(detailFor('failed'))
    retry.mockResolvedValue({
      task_id: 'task-a',
      run_id: 'run-2',
      revision: 8,
      task_state: 'open',
      display_state: 'queued',
    })
    renderPage()
    await settle()

    expect(screen.getByText('task.retryTitle')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'task.retryButton' }))
    await settle()

    expect(retry).toHaveBeenCalledTimes(1)
    const [taskId, body] = retry.mock.calls[0]
    expect(taskId).toBe('task-a')
    expect(body.expected_revision).toBe(7)
    expect(body.target).toEqual({ kind: 'cloud', profile: 'text-v1' })
    expect(body.client_request_id).toMatch(/^[A-Za-z0-9-]{8,128}$/)
    expect(screen.queryByText('task.retryError')).not.toBeInTheDocument()
  })

  it('hides retry while the task is still running', async () => {
    fetchTask.mockResolvedValue(detailFor('running'))
    renderPage()
    await settle()
    expect(screen.queryByText('task.retryTitle')).not.toBeInTheDocument()
  })

  it('asks for a refresh instead of claiming success when the run is not quiescent', async () => {
    fetchTask.mockResolvedValue(detailFor('run_canceled'))
    retry.mockRejectedValue({ code: 'task_has_active_run' })
    renderPage()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'task.retryButton' }))
    await settle()
    expect(screen.getByText('task.retryStale')).toBeInTheDocument()
    expect(screen.queryByText('task.retryError')).not.toBeInTheDocument()
  })
})
