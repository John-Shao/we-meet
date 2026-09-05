import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const renderPicker = ({
  onRoleChange = vi.fn(),
}: { onRoleChange?: ReturnType<typeof vi.fn> } = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <AttendeePicker
        selected={new Map([['attendee-1', 'Alice']])}
        onToggle={vi.fn()}
        roles={new Map([['attendee-1', 'required' as const]])}
        onRoleChange={onRoleChange}
        selfId="organizer-1"
        organizer={{
          id: 'organizer-1',
          label: 'Owner',
          avatarUrl: '/owner.png',
        }}
      />
    </QueryClientProvider>
  )

  return { ...view, onRoleChange }
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

  it('changes attendee roles through the shared select', async () => {
    const user = userEvent.setup()
    const { onRoleChange } = renderPicker()

    await user.click(
      screen.getByRole('button', { name: /form\.attendeeRole/ })
    )
    await user.click(await screen.findByRole('option', { name: 'form.optional' }))

    expect(onRoleChange).toHaveBeenCalledWith('attendee-1', 'optional')
  })
})
