import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkHeader } from './WorkApp'

const inbox = vi.hoisted(() => ({
  pages: [] as { items: unknown[]; next_cursor: string | null }[],
}))

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useLocation: () => ['/work', () => {}],
  navigate: () => {},
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('./api/queries', () => ({
  useWorkBootstrap: () => ({ data: undefined, isLoading: false }),
  useWorkInbox: () => ({
    data: inbox.pages.length > 0 ? { pages: inbox.pages } : undefined,
    isLoading: false,
    isError: false,
  }),
}))

const item = (taskId: string) => ({
  task_id: taskId,
  type: 'acceptance_required',
  title: 'Task',
  display_state: 'awaiting_acceptance',
  updated_at: '2026-11-02T10:00:00Z',
})

// WorkHeader takes the member's role as a plain prop; passing it through a
// binding keeps the a11y lint from reading the literal as an ARIA role.
const memberRole = 'member'
const ownerRole = 'owner'

beforeEach(() => {
  inbox.pages = []
})

afterEach(cleanup)

// D5 §5.2 puts the inbox on a 30s poll that feeds both the home section and this
// nav badge, and rules out a cross-task SSE. The badge is the only place a count
// appears outside the home page, so its arithmetic is worth pinning: a hidden
// badge must not be mistaken for "nothing needs you" when the read is merely
// empty, and a full first page must not claim an exact number.
describe('WorkHeader needs-you badge', () => {
  it('stays absent when nothing needs the owner', () => {
    inbox.pages = [{ items: [], next_cursor: null }]
    render(<WorkHeader orgName="Acme" role={memberRole} />)
    expect(screen.getByRole('link', { name: 'nav.home' })).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('shows the count while it is exact', () => {
    inbox.pages = [{ items: [item('t-1'), item('t-2')], next_cursor: null }]
    render(<WorkHeader orgName="Acme" role={memberRole} />)
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.queryByText('2+')).toBeNull()
  })

  it('marks the count open when a next page exists', () => {
    inbox.pages = [
      {
        items: Array.from({ length: 20 }, (_unused, index) =>
          item(`task-${index}`)
        ),
        next_cursor: 'cursor-2',
      },
    ]
    render(<WorkHeader orgName="Acme" role={memberRole} />)
    expect(screen.getByText('20+')).toBeTruthy()
  })

  it('stays absent before the first answer arrives', () => {
    render(<WorkHeader orgName="Acme" role={memberRole} />)
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getByRole('link', { name: 'nav.items' })).toBeTruthy()
  })

  it('hides the count from assistive tech, since the section states it', () => {
    inbox.pages = [{ items: [item('t-1')], next_cursor: null }]
    render(<WorkHeader orgName="Acme" role={ownerRole} />)
    const badge = screen.getByText('1')
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    // The admin entry only exists for owner/admin, and the badge must not
    // disturb the links an automated check addresses by name.
    expect(screen.getByRole('link', { name: 'nav.admin' })).toBeTruthy()
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })
})
