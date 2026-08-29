import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskSettingsDialog } from './TaskSettingsDialog'

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
      default_reminder_minutes: 60,
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

describe('TaskSettingsDialog', () => {
  it('renders server settings and patches each changed preference', () => {
    render(<TaskSettingsDialog onClose={vi.fn()} />)

    expect(
      screen.getByRole('switch', { name: 'settings.dailyReminder' })
    ).toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'settings.overdueMarker' })
    ).not.toBeChecked()

    fireEvent.click(
      screen.getByRole('switch', { name: 'settings.dailyReminder' })
    )
    fireEvent.click(
      screen.getByRole('switch', { name: 'settings.overdueMarker' })
    )
    fireEvent.change(
      screen.getByRole('combobox', { name: 'settings.defaultReminder' }),
      { target: { value: '1440' } }
    )

    expect(mocks.mutate).toHaveBeenNthCalledWith(1, {
      daily_reminder_enabled: false,
    })
    expect(mocks.mutate).toHaveBeenNthCalledWith(2, {
      overdue_marker_enabled: true,
    })
    expect(mocks.mutate).toHaveBeenNthCalledWith(3, {
      default_reminder_minutes: 1440,
    })
  })
})
