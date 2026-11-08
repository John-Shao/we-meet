import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ArchivePage } from './ArchivePage'

let legacyTask: string | null = null
const viewCalls = vi.hoisted(() => ({ views: [] as string[] }))

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useSearchParams: () => [{ get: () => legacyTask }],
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/queries', () => ({
  useWorkTasks: (view: string) => {
    viewCalls.views.push(view)
    return {
      data: {
        pages: [
          {
            items: [
              {
                task_id: 'task-1',
                title: 'Archived task',
                display_state: 'archived',
              },
            ],
          },
        ],
      },
      isLoading: false,
      isError: false,
    }
  },
}))
vi.mock('../components/TaskCard', () => ({
  TaskCard: ({ task }: { task: { title: string } }) => <div>{task.title}</div>,
}))

afterEach(() => {
  cleanup()
  legacyTask = null
  viewCalls.views.length = 0
})

describe('ArchivePage', () => {
  it('asks the server for the archived view', () => {
    render(<ArchivePage />)
    expect(viewCalls.views).toContain('archived')
  })

  it('shows only archived tasks', () => {
    render(<ArchivePage />)
    expect(screen.getByText('Archived task')).toBeInTheDocument()
  })

  it('shows a read-only notice for legacy task links', () => {
    legacyTask = 'legacy-1'
    render(<ArchivePage />)
    expect(screen.getByText('archive.legacyNotice')).toBeInTheDocument()
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument()
  })
})
