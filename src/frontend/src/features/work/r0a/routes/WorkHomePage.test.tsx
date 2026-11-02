import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkHomePage } from './WorkHomePage'
import { setWorkTelemetrySink } from '../telemetry'

type InboxPageFixture = {
  pages: {
    items: {
      task_id: string
      type: string
      title: string
      display_state: string
      updated_at: string
    }[]
  }[]
}

const mocks = vi.hoisted(() => ({
  inbox: {
    data: {
      pages: [
        {
          items: [
            {
              task_id: 'task-9',
              type: 'acceptance_required',
              title: 'Needs you task',
              display_state: 'awaiting_acceptance',
              updated_at: '2026-11-02T10:00:00Z',
            },
          ],
        },
      ],
    } as InboxPageFixture | undefined,
    isLoading: false,
    isError: false,
  },
}))

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh' },
  }),
}))
vi.mock('../api/queries', () => ({
  useWorkBootstrap: () => ({
    data: {
      subject_id: 'subject',
      org: { id: 'org', name: 'Test', role: 'member', work_seat: true },
      permissions: [],
      phases: ['R0a'],
      execution_targets: [],
      allowed_permission_modes: ['ask_each'],
      limits: {
        max_goal_chars: 2000,
        max_background_chars: 4000,
        max_artifact_bytes: 262144,
        max_active_runs: 3,
      },
      csrf_token: 'test',
    },
  }),
  useWorkTasks: () => ({
    data: {
      pages: [{ items: [{ task_id: 'task-1', title: 'First task' }] }],
    },
    isLoading: false,
  }),
  useWorkInbox: () => mocks.inbox,
}))
vi.mock('../components/Composer', () => ({
  Composer: () => <div>composer</div>,
}))
vi.mock('../components/TaskCard', () => ({
  TaskCard: ({ task }: { task: { title: string } }) => <div>{task.title}</div>,
}))

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkHomePage read-only viewport', () => {
  it('hides the composer and shows the hint below 768px', () => {
    stubViewport(true)
    render(<WorkHomePage />)
    expect(screen.queryByText('composer')).not.toBeInTheDocument()
    expect(screen.getByText('readOnly.homeHint')).toBeInTheDocument()
    expect(screen.getByText('First task')).toBeInTheDocument()
  })

  it('shows the composer at 768px and above', () => {
    stubViewport(false)
    render(<WorkHomePage composerOpen />)
    expect(screen.getByText('composer')).toBeInTheDocument()
    expect(screen.queryByText('readOnly.homeHint')).not.toBeInTheDocument()
  })
})

describe('WorkHomePage needs-you projection', () => {
  afterEach(() => {
    mocks.inbox.data = {
      pages: [
        {
          items: [
            {
              task_id: 'task-9',
              type: 'acceptance_required',
              title: 'Needs you task',
              display_state: 'awaiting_acceptance',
              updated_at: '2026-11-02T10:00:00Z',
            },
          ],
        },
      ],
    }
    mocks.inbox.isLoading = false
    mocks.inbox.isError = false
  })

  it('lists actionable tasks and links each to its workspace', () => {
    stubViewport(false)
    render(<WorkHomePage composerOpen />)
    expect(screen.getByText('home.needsYou')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Needs you task/ })
    expect(link).toHaveAttribute('href', '/work/items/task-9')
    // The status badge is the action reason; the projection carries no run detail.
    expect(screen.getByText('status.awaiting_acceptance')).toBeInTheDocument()
  })

  it('says so when nothing needs the owner', () => {
    stubViewport(false)
    mocks.inbox.data = { pages: [{ items: [] }] }
    render(<WorkHomePage composerOpen />)
    expect(screen.getByText('home.emptyInbox')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Needs you task/ })).toBeNull()
  })

  // The inbox is a secondary projection: its failure must not take the composer
  // or the recent list down with it.
  it('keeps the rest of the page when the inbox read fails', () => {
    stubViewport(false)
    mocks.inbox.data = undefined
    mocks.inbox.isError = true
    render(<WorkHomePage composerOpen />)
    expect(screen.getByText('home.inboxUnavailable')).toBeInTheDocument()
    expect(screen.getByText('composer')).toBeInTheDocument()
    expect(screen.getByText('First task')).toBeInTheDocument()
  })
})

describe('WorkHomePage telemetry', () => {
  afterEach(() => {
    setWorkTelemetrySink(null)
  })

  it('reports a home view and one inbox open, with no prose', () => {
    const sink = vi.fn()
    setWorkTelemetrySink(sink)
    stubViewport(false)
    render(<WorkHomePage composerOpen />)

    expect(sink.mock.calls.map((call) => call[0])).toEqual([
      'work_r0a_home_view',
      'inbox_open',
    ])
    // D5 §10:306 forbids titles and body text in telemetry. The fixture holds both,
    // so this is the assertion that would catch a payload copy-paste.
    const wire = JSON.stringify(sink.mock.calls)
    expect(wire).not.toContain('Needs you task')
    expect(wire).not.toContain('task-9')
    expect(wire).not.toContain('First task')
  })

  it('stays quiet about the inbox when nothing needs the owner', () => {
    const sink = vi.fn()
    setWorkTelemetrySink(sink)
    stubViewport(false)
    mocks.inbox.data = { pages: [{ items: [] }] }
    render(<WorkHomePage composerOpen />)

    expect(sink.mock.calls.map((call) => call[0])).toEqual([
      'work_r0a_home_view',
    ])
  })
})
