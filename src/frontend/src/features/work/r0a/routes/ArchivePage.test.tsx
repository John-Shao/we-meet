import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ArchivePage } from './ArchivePage'

let legacyTask: string | null = null

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useSearchParams: () => [
    { get: () => legacyTask },
  ],
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/queries', () => ({
  useWorkTasks: () => ({
    data: {
      pages: [
        {
          items: [
            { task_id: 'task-1', title: 'Archived task', display_state: 'archived' },
            { task_id: 'task-2', title: 'Active task', display_state: 'active' },
          ],
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('../components/TaskCard', () => ({
  TaskCard: ({ task }: { task: { title: string } }) => <div>{task.title}</div>,
}))

afterEach(() => {
  cleanup()
  legacyTask = null
})

describe('ArchivePage', () => {
  it('shows only archived tasks', () => {
    render(<ArchivePage />)
    expect(screen.getByText('Archived task')).toBeInTheDocument()
    expect(screen.queryByText('Active task')).not.toBeInTheDocument()
  })

  it('shows a read-only notice for legacy task links', () => {
    legacyTask = 'legacy-1'
    render(<ArchivePage />)
    expect(screen.getByText('archive.legacyNotice')).toBeInTheDocument()
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument()
  })
})
