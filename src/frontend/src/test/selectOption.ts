import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'

export function selectName(label: string) {
  return new RegExp(`(?:^| )${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/** Exercise the visible React Aria popup instead of its hidden form select. */
export async function selectOption(label: string, value: string) {
  const fakeTimers = vi.isFakeTimers()
  const user = userEvent.setup()
  const trigger = fakeTimers
    ? screen.getByRole('button', { name: selectName(label) })
    : await screen.findByRole('button', { name: selectName(label) })
  if (fakeTimers) fireEvent.click(trigger)
  else await user.click(trigger)
  const list = screen.getByRole('listbox')
  const option = within(list)
    .getAllByRole('option')
    .find((item) => item.getAttribute('data-key') === value)
  if (!option) throw new Error(`Missing option ${value} for ${label}`)
  if (fakeTimers) fireEvent.click(option)
  else await user.click(option)
}
