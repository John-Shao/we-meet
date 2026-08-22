import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import zhTasks from '@/locales/zh/tasks.json'

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
      screen.getByRole('button', { name: 'workspace.createCancel' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'workspace.createSubmit' })
    ).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'form.today' }))
    expect(screen.getByLabelText('form.dueDate')).toHaveValue(
      localDateValue(new Date())
    )
  })

  it('uses the expected Chinese create action labels', () => {
    expect(zhTasks.workspace.createCancel).toBe('取消')
    expect(zhTasks.workspace.createSubmit).toBe('新建')
  })
})

const localDateValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
