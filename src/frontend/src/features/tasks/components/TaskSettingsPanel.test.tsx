import { fireEvent, render, screen } from '@testing-library/react'
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
      default_reminder_minutes: 0,
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
  it('renders server settings and patches each changed preference', () => {
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
    fireEvent.change(
      screen.getByRole('combobox', { name: 'settings.defaultReminder' }),
      { target: { value: '4320' } }
    )
    fireEvent.change(
      screen.getByRole('combobox', { name: 'settings.defaultReminder' }),
      { target: { value: 'none' } }
    )

    expect(mocks.mutate).toHaveBeenNthCalledWith(1, {
      overdue_marker_enabled: true,
    })
    expect(mocks.mutate).toHaveBeenNthCalledWith(2, {
      daily_reminder_enabled: true,
      default_reminder_minutes: 4320,
    })
    expect(mocks.mutate).toHaveBeenNthCalledWith(3, {
      daily_reminder_enabled: false,
    })
  })
})
