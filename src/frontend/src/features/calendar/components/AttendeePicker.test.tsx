import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AttendeePicker } from './AttendeePicker'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; name?: string }) =>
      key === 'form.selected'
        ? `selected ${options?.count}`
        : key === 'form.removeAttendee'
          ? `remove ${options?.name}`
          : key,
  }),
}))

vi.mock('@/features/contacts', () => ({
  MemberAvatar: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>,
  DirectoryMultiPicker: () => null,
}))

const renderPicker = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AttendeePicker
        selected={new Map([['attendee-1', 'Alice']])}
        onToggle={vi.fn()}
        roles={new Map([['attendee-1', 'required' as const]])}
        onRoleChange={vi.fn()}
        selfId="organizer-1"
        organizer={{
          id: 'organizer-1',
          label: 'Owner',
          avatarUrl: '/owner.png',
        }}
      />
    </QueryClientProvider>
  )
}

describe('AttendeePicker organizer', () => {
  it('includes the organizer in the count as a fixed participant', () => {
    renderPicker()

    expect(screen.getByText(/selected 2/)).toBeInTheDocument()
    const organizerRow = screen.getByTestId('attendee-organizer')
    expect(within(organizerRow).getByText('Owner')).toBeInTheDocument()
    expect(within(organizerRow).getByText('card.organizer')).toBeInTheDocument()
    expect(within(organizerRow).queryByRole('button')).not.toBeInTheDocument()
    expect(within(organizerRow).queryByRole('combobox')).not.toBeInTheDocument()

    expect(
      screen.getByRole('button', { name: 'remove Alice' })
    ).toBeInTheDocument()
  })
})
