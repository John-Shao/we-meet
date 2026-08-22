import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TaskForm } from './TaskForm'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/fetchTasks', () => ({
  useCreateTask: () => ({
    mutateAsync: vi.fn(),
    error: null,
    isPending: false,
  }),
  usePatchTask: () => ({
    mutateAsync: vi.fn(),
    error: null,
    isPending: false,
  }),
}))

describe('TaskForm create mode', () => {
  it('uses the compact create labels and supports quick due dates', () => {
    render(
      <TaskForm
        mode="create"
        labels={[]}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    expect(
      screen.getByPlaceholderText('form.createTitlePlaceholder')
    ).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText('form.createDescriptionPlaceholder')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'form.cancel' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'form.create' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'form.today' }))
    expect(screen.getByLabelText('form.dueDate')).toHaveValue(
      localDateValue(new Date())
    )
  })
})

const localDateValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
