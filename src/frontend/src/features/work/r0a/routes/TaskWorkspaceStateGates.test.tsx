import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskWorkspacePage } from './TaskWorkspacePage'
import { fetchWorkTask } from '../api/client'
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
}))
vi.mock('../components/ArtifactPanel', () => ({
  ArtifactPanel: () => <div>Artifact</div>,
}))

const detailWith = (patch: {
  display: string
  pending?: boolean
  blocking?: number
}): WorkTaskDetail => ({
  summary: {
    task_id: 'task-a',
    title: 'Gated task',
    display_state: patch.display,
    task_state: patch.display,
    permission_mode: 'ask_each',
    active_run_id: null,
    latest_run_id: null,
    latest_run: null,
    latest_artifact: {
      artifact_id: 'final-artifact',
      version_no: 1,
      content_hash: 'hash',
    },
    revision: 7,
    pending_acceptance: patch.pending ?? false,
    blocking_operations: patch.blocking ?? 0,
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

describe('task workspace state gates', () => {
  it('offers acceptance only when the task really awaits it with no blocking operation', async () => {
    fetchTask.mockResolvedValue(
      detailWith({ display: 'awaiting_acceptance', pending: true })
    )
    renderPage()
    await settle()
    expect(screen.getByText('task.acceptTitle')).toBeInTheDocument()

    cleanup()
    fetchTask.mockResolvedValue(
      detailWith({
        display: 'awaiting_acceptance',
        pending: true,
        blocking: 2,
      })
    )
    renderPage()
    await settle()
    expect(screen.queryByText('task.acceptTitle')).not.toBeInTheDocument()

    cleanup()
    fetchTask.mockResolvedValue(
      detailWith({ display: 'awaiting_acceptance', pending: false })
    )
    renderPage()
    await settle()
    expect(screen.queryByText('task.acceptTitle')).not.toBeInTheDocument()
  })

  it('derives cancellation from display_state rather than a second state machine', async () => {
    for (const display of ['queued', 'running', 'reconciling']) {
      fetchTask.mockResolvedValue(detailWith({ display }))
      renderPage()
      await settle()
      expect(screen.getByRole('button', { name: 'task.cancelRun' })).toBeInTheDocument()
      cleanup()
    }

    fetchTask.mockResolvedValue(detailWith({ display: 'quota_exhausted' }))
    renderPage()
    await settle()
    expect(screen.getByRole('button', { name: 'task.cancelRun' })).toBeInTheDocument()
    cleanup()

    for (const display of ['completed', 'awaiting_acceptance', 'failed']) {
      fetchTask.mockResolvedValue(detailWith({ display }))
      renderPage()
      await settle()
      expect(
        screen.queryByRole('button', { name: 'task.cancelRun' })
      ).not.toBeInTheDocument()
      cleanup()
    }
  })

})
