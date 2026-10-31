import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactWorkspacePage } from './ArtifactWorkspacePage'
import {
  acceptWorkTask,
  fetchWorkArtifactContent,
  fetchWorkArtifactWorkspace,
} from '../api/client'
import type { WorkTaskArtifactWorkspace } from '../api/types'

const search = vi.hoisted(() => {
  let params = new URLSearchParams()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    getParams: () => params,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setSearchParams: vi.fn(
      (
        next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams)
      ) => {
        params = typeof next === 'function' ? next(params) : next
        notify()
      }
    ),
    set: (key: string, value: string) => {
      params = new URLSearchParams(params)
      params.set(key, value)
      notify()
    },
    reset: () => {
      params = new URLSearchParams()
      listeners.clear()
    },
  }
})

vi.mock('wouter', async (importOriginal) => {
  const React = await import('react')
  return {
    ...(await importOriginal<typeof import('wouter')>()),
    useParams: () => ({ taskId: 'task-a', artifactId: 'artifact-a' }),
    useSearchParams: () => [
      React.useSyncExternalStore(
        search.subscribe,
        search.getParams,
        search.getParams
      ),
      search.setSearchParams,
    ],
  }
})
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'version' in options ? `${key} v${options.version}` : key,
  }),
}))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchWorkArtifactWorkspace: vi.fn(),
  fetchWorkArtifactContent: vi.fn(),
  acceptWorkTask: vi.fn(),
}))

const workspace = (
  acceptedVersionNo: number | null = 1
): WorkTaskArtifactWorkspace => ({
  summary: {
    task_id: 'task-a',
    title: 'Task A',
    display_state: 'awaiting_acceptance',
    task_state: 'awaiting_acceptance',
    permission_mode: 'ask_each',
    active_run_id: null,
    latest_run_id: null,
    latest_run: null,
    latest_artifact: {
      artifact_id: 'artifact-a',
      version_no: 2,
      content_hash: 'sha256:hash',
    },
    revision: 3,
    pending_acceptance: true,
    blocking_operations: 0,
    quota: { reserved_tokens: 1000, settled_tokens: 200 },
    created_at: '2026-10-31T00:00:00Z',
    updated_at: '2026-10-31T00:00:00Z',
  },
  artifact: {
    artifact_id: 'artifact-a',
    logical_name: 'result',
    state: 'published',
    revision: 0,
    created_at: '2026-10-31T00:00:00Z',
    updated_at: '2026-10-31T00:00:00Z',
    accepted_version_no: acceptedVersionNo,
    versions: [
      {
        version_no: 2,
        media_type: 'text/markdown',
        bytes: 12,
        content_hash: 'sha256:hash-two',
        state: 'published',
        content_url:
          '/work/v1/tasks/task-a/artifacts/artifact-a/versions/2/content',
        created_at: '2026-10-31T01:00:00Z',
        published_at: '2026-10-31T01:00:00Z',
      },
      {
        version_no: 1,
        media_type: 'text/markdown',
        bytes: 10,
        content_hash: 'sha256:hash-one',
        state: 'published',
        content_url:
          '/work/v1/tasks/task-a/artifacts/artifact-a/versions/1/content',
        created_at: '2026-10-31T00:30:00Z',
        published_at: '2026-10-31T00:30:00Z',
      },
    ],
  },
})

const fetchWorkspace = vi.mocked(fetchWorkArtifactWorkspace)
const fetchContent = vi.mocked(fetchWorkArtifactContent)
const accept = vi.mocked(acceptWorkTask)

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

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ArtifactWorkspacePage />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  search.reset()
  stubViewport(false)
  fetchWorkspace.mockReset()
  fetchContent.mockReset()
  accept.mockReset()
  fetchContent.mockImplementation((_taskId, _artifactId, versionNo) =>
    Promise.resolve({
      text: `content v${versionNo}`,
      mediaType: 'text/markdown',
    })
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ArtifactWorkspacePage', () => {
  it('renders the independent page with versions, preview, acceptance and export', async () => {
    fetchWorkspace.mockResolvedValue(workspace())
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'Task A' })
    ).toBeInTheDocument()
    expect(await screen.findByText('content v2')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'artifact.selectVersion v1' })
    ).toBeInTheDocument()
    expect(screen.getByText('artifact.acceptedBadge')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'artifact.backToTask' })
    ).toHaveAttribute('href', '/work/items/task-a')
    expect(
      screen.getByRole('link', { name: 'artifact.download' })
    ).toHaveAttribute(
      'href',
      '/work/v1/tasks/task-a/artifacts/artifact-a/versions/2/content?disposition=attachment'
    )
  })

  it('opens the version from the deep link and switches versions in place', async () => {
    search.set('version', '1')
    fetchWorkspace.mockResolvedValue(workspace())
    renderPage()

    expect(await screen.findByText('content v1')).toBeInTheDocument()
    expect(fetchContent).toHaveBeenCalledWith('task-a', 'artifact-a', 1)

    fireEvent.click(
      screen.getByRole('button', { name: 'artifact.selectVersion v2' })
    )
    expect(search.setSearchParams).toHaveBeenCalled()
    expect(await screen.findByText('content v2')).toBeInTheDocument()
    expect(fetchContent).toHaveBeenCalledWith('task-a', 'artifact-a', 2)
  })

  it('accepts the selected version with the task revision', async () => {
    fetchWorkspace.mockResolvedValue(workspace(null))
    accept.mockResolvedValue({} as never)
    renderPage()

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'artifact.confirmAccept v2',
      })
    )
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1))
    expect(accept).toHaveBeenCalledWith(
      'task-a',
      expect.objectContaining({
        expected_revision: 3,
        artifact_id: 'artifact-a',
        version_no: 2,
      })
    )
  })

  it('shows a not-found state for a deep link the server rejects', async () => {
    fetchWorkspace.mockRejectedValue(new Error('artifact_not_found'))
    renderPage()

    expect(
      await screen.findByText('artifact.loadErrorTitle')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'artifact.backToTask' })
    ).toBeInTheDocument()
  })

  it('keeps the page read-only on mobile', async () => {
    stubViewport(true)
    fetchWorkspace.mockResolvedValue(workspace(null))
    renderPage()

    expect(await screen.findByText('artifact.readOnly')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'artifact.confirmAccept v2' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'artifact.selectVersion v1' })
    ).toBeInTheDocument()
  })
})
