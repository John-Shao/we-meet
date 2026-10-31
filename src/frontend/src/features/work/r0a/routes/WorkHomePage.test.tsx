import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkHomePage } from './WorkHomePage'

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
