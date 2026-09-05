import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  fetchCalendarGrants,
  fetchCalendarSubscriptions,
  fetchMyPersonalCalendar,
  subscribeCalendar,
} from '../api/personalCalendars'
import { CalendarSharingDialog } from './CalendarSharingDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/personalCalendars', () => ({
  deleteCalendarGrant: vi.fn(),
  fetchCalendarGrants: vi.fn(),
  fetchCalendarSubscriptions: vi.fn(),
  fetchMyPersonalCalendar: vi.fn(),
  saveCalendarGrant: vi.fn(),
  subscribeCalendar: vi.fn(),
  unsubscribeCalendar: vi.fn(),
  updatePersonalCalendar: vi.fn(),
}))

vi.mock('@/features/contacts/components/DirectoryMultiPicker', () => ({
  DirectoryMultiPicker: ({
    onToggle,
  }: {
    onToggle: (id: string, label: string) => void
  }) => (
    <button type="button" onClick={() => onToggle('person-1', 'Alice')}>
      pick-person
    </button>
  ),
}))

const renderDialog = () => {
  vi.mocked(fetchMyPersonalCalendar).mockResolvedValue({
    id: 'calendar-1',
    owner: { id: 'self', full_name: 'Self' },
    organization: { id: 'org-1', name: 'Organization' },
    organization_default_access: 'free_busy',
    effective_permission: 'details',
    subscribed: false,
  })
  vi.mocked(fetchCalendarGrants).mockResolvedValue([])
  vi.mocked(fetchCalendarSubscriptions).mockResolvedValue([])
  vi.mocked(subscribeCalendar).mockResolvedValue({
    id: 'subscription-1',
    calendar_id: 'calendar-2',
    owner: { id: 'person-1', full_name: 'Alice' },
    permission: 'details',
    enabled: true,
    color: '#3370ff',
  })

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <CalendarSharingDialog onClose={vi.fn()} onChanged={vi.fn()} />
    </QueryClientProvider>
  )

  return { ...view, client }
}

describe('CalendarSharingDialog', () => {
  it('uses shared segmented and select controls while preserving subscribe flow', async () => {
    const user = userEvent.setup()
    const { container } = renderDialog()

    expect(
      screen.getByRole('button', { name: /sharing\.organizationDefault/ })
    ).toHaveAttribute('aria-haspopup', 'listbox')
    expect(
      container.querySelector('select')?.closest('[aria-hidden="true"]')
    ).not.toBeNull()
    expect(
      screen.getByRole('tab', { name: 'sharing.share' })
    ).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: 'sharing.subscribe' }))
    await user.click(screen.getByRole('button', { name: 'pick-person' }))
    await user.click(
      screen.getByRole('button', { name: 'sharing.subscribeAction' })
    )

    await waitFor(() =>
      expect(subscribeCalendar).toHaveBeenCalledWith('person-1')
    )
  })
})
