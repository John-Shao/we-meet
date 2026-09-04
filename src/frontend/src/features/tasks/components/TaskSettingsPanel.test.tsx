import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskSettingsPanel } from './TaskSettingsPanel'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTaskSettings: () => ({
    data: {
      daily_reminder_enabled: true,
      overdue_marker_enabled: false,
      default_reminder_minutes: 900,
    },
    isLoading: false,
    error: null,
    refetch: mocks.refetch,
  }),
  useUpdateTaskSettings: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
  }),
}))

beforeEach(() => {
  mocks.mutate.mockReset()
  mocks.refetch.mockReset()
})

describe('TaskSettingsPanel', () => {
  it('renders server settings and patches each changed preference', async () => {
    const user = userEvent.setup()
    render(<TaskSettingsPanel />)

    expect(
      screen.queryByRole('switch', { name: 'settings.dailyReminder' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'settings.overdueMarker' })
    ).not.toBeChecked()

    fireEvent.click(
      screen.getByRole('switch', { name: 'settings.overdueMarker' })
    )
    const reminderSelect = screen.getByRole('button', {
      name: /settings\.defaultReminder/,
    })
    expect(reminderSelect).toHaveAttribute('aria-haspopup', 'listbox')
    expect(
      document.querySelector('select:not([tabindex="-1"])')
    ).not.toBeInTheDocument()

    await user.click(reminderSelect)
    await user.click(
      screen.getByRole('option', {
        name: 'settings.reminderOptions.3780',
      })
    )

    await user.click(reminderSelect)
    await user.click(
      screen.getByRole('option', {
        name: 'settings.reminderOptions.none',
      })
    )

    expect(mocks.mutate).toHaveBeenNthCalledWith(1, {
      overdue_marker_enabled: true,
    })
    expect(mocks.mutate).toHaveBeenNthCalledWith(2, {
      daily_reminder_enabled: true,
      default_reminder_minutes: 3780,
    })
    expect(mocks.mutate).toHaveBeenNthCalledWith(3, {
      daily_reminder_enabled: false,
    })
  })
})
