import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskReminderControl } from './TaskReminderControl'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTaskReminder: () => ({
    data: {
      enabled: true,
      reminder_minutes: null,
      effective_reminder_minutes: 2340,
      global_reminders_enabled: true,
    },
    isLoading: false,
    error: null,
    refetch: mocks.refetch,
  }),
  useUpdateTaskReminder: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
  }),
}))

beforeEach(() => {
  mocks.mutate.mockReset()
  mocks.refetch.mockReset()
})

describe('TaskReminderControl', () => {
  it("patches the current participant's isolated reminder settings", () => {
    render(<TaskReminderControl taskId="task-1" />)

    expect(
      screen.queryByRole('switch', { name: 'taskReminder.enabled' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'taskReminder.timing' })
    ).toHaveValue('default')

    fireEvent.change(
      screen.getByRole('combobox', { name: 'taskReminder.timing' }),
      { target: { value: 'none' } }
    )
    fireEvent.change(
      screen.getByRole('combobox', { name: 'taskReminder.timing' }),
      { target: { value: '360' } }
    )

    expect(mocks.mutate).toHaveBeenNthCalledWith(1, { enabled: false })
    expect(mocks.mutate).toHaveBeenNthCalledWith(2, {
      enabled: true,
      reminder_minutes: 360,
    })
  })
})
