import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskWorkspacePage } from './TaskWorkspacePage'
import { deleteWorkTask, fetchWorkTask } from '../api/client'
import type { WorkTaskDetail } from '../api/types'

const nav = vi.hoisted(() => ({ to: '' }))
vi.mock('wouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wouter')>()),
  useParams: () => ({ taskId: 'task-a' }),
  useLocation: () => ['/', (to: string) => (nav.to = to)],
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchWorkTask: vi.fn(),
  openWorkEventStream: vi.fn(),
  deleteWorkTask: vi.fn(),
}))
vi.mock('../components/ArtifactPanel', () => ({
  ArtifactPanel: () => <div>Artifact</div>,
}))

const detailFor = (displayState: string): WorkTaskDetail => ({
  summary: {
    task_id: 'task-a',
    title: 'Delete me',
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
const remove = vi.mocked(deleteWorkTask)

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
  nav.to = ''
  fetchTask.mockReset()
  remove.mockReset()
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

describe('task workspace delete affordance', () => {
  it('deletes a quiescent task through a two-step confirm and leaves the workspace', async () => {
    fetchTask.mockResolvedValue(detailFor('completed'))
    remove.mockResolvedValue({
      task_id: 'task-a',
      deleted_at: '2026-11-01T00:00:00Z',
      content_purge: 'scheduled',
    })
    renderPage()
    await settle()

    expect(screen.getByText('task.deleteTitle')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'task.deleteButton' }))
    expect(screen.getByText('task.deleteConfirm')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'task.deleteConfirmButton' })
    )
    await settle()
    expect(remove).toHaveBeenCalledWith('task-a', 7)
    expect(nav.to).toBe('/work/items')
  })

  it('hides the delete section while the task is running', async () => {
    fetchTask.mockResolvedValue(detailFor('running'))
    renderPage()
    await settle()
    expect(screen.queryByText('task.deleteTitle')).not.toBeInTheDocument()
  })

  it('explains a non-quiescent rejection instead of pretending success', async () => {
    fetchTask.mockResolvedValue(detailFor('completed'))
    remove.mockRejectedValue({ code: 'run_not_quiescent' })
    renderPage()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'task.deleteButton' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'task.deleteConfirmButton' })
    )
    await settle()
    expect(screen.getByText('task.deleteBlocked')).toBeInTheDocument()
    expect(nav.to).toBe('')
  })

  it('keeps the delete affordance off the read-only phone viewport', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      media: '(max-width: 767px)',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
    fetchTask.mockResolvedValue(detailFor('completed'))
    renderPage()
    await settle()
    expect(screen.queryByText('task.deleteTitle')).not.toBeInTheDocument()
  })
})
