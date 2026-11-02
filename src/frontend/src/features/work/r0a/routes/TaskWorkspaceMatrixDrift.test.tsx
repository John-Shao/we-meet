import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// The signed state matrix, read from the design asset instead of being re-typed here:
// the point of this file is to fail when the shipped page and the asset disagree.
interface StateMatrix {
  version: string
  states: Record<string, { actions: string[] }>
  constraints: {
    accept: { onlyStates: string[] }
    retry: { onlyStates: string[] }
    cancel: { onlyStates: string[] }
  }
  management: { delete: { states: string[] } }
}

const readMatrix = (): StateMatrix => {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let hop = 0; hop < 12; hop += 1) {
    const candidate = join(
      directory,
      'docs',
      'plan',
      'assets',
      'work-r0a-frontend-2026-10-25',
      'state-matrix.json'
    )
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as StateMatrix
    }
    directory = dirname(directory)
  }
  throw new Error('state-matrix.json is not reachable from this test file')
}

const matrix = readMatrix()
const displayStates = Object.keys(matrix.states)

const detailWith = (display: string): WorkTaskDetail => ({
  summary: {
    task_id: 'task-a',
    title: 'Matrix task',
    display_state: display,
    task_state: display,
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
    pending_acceptance: display === 'awaiting_acceptance',
    blocking_operations: 0,
    quota: { reserved_tokens: 0, settled_tokens: 0 },
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  },
  input_ref: 'input',
  goal: 'Matrix goal',
  background: null,
  template: null,
  snapshot: null,
  latest_event_id: 'cursor-1',
})

const fetchTask = vi.mocked(fetchWorkTask)

const renderPage = async (display: string) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  fetchTask.mockResolvedValue(detailWith(display))
  render(
    <QueryClientProvider client={client}>
      <TaskWorkspacePage />
    </QueryClientProvider>
  )
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

describe('task workspace against the signed state matrix', () => {
  it('reads the twelve display states the asset declares', () => {
    expect(displayStates).toHaveLength(12)
    expect(matrix.version).toBe('r0a-v1')
  })

  // D5 §14 asks for the views to cover all twelve states. Every affordance below is
  // asserted in both directions, so a state the page silently stops handling shows up
  // as a failure instead of as a missing button nobody notices.
  it.each(displayStates)(
    'offers exactly the matrix actions for %s',
    async (display) => {
      await renderPage(display)

      const offers = (name: string) =>
        screen.queryByText(name) !== null ||
        screen.queryByRole('button', { name }) !== null

      expect(offers('task.cancelRun')).toBe(
        matrix.constraints.cancel.onlyStates.includes(display)
      )
      expect(offers('task.retryTitle')).toBe(
        matrix.constraints.retry.onlyStates.includes(display)
      )
      expect(offers('task.acceptTitle')).toBe(
        matrix.constraints.accept.onlyStates.includes(display)
      )
      expect(offers('task.deleteTitle')).toBe(
        matrix.management.delete.states.includes(display)
      )
    }
  )
})
