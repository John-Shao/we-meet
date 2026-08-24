import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import zhTasks from '@/locales/zh/tasks.json'

import { TaskForm } from './TaskForm'

const { createTask, createSubtask } = vi.hoisted(() => ({
  createTask: vi.fn(),
  createSubtask: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/fetchTasks', () => ({
  useCreateTask: () => ({
    mutateAsync: createTask,
    error: null,
    isPending: false,
  }),
  useCreateTaskSubtask: () => ({
    mutateAsync: createSubtask,
    error: null,
    isPending: false,
  }),
}))

describe('TaskForm create mode', () => {
  beforeEach(() => {
    createTask.mockReset()
    createSubtask.mockReset()
  })

  it('uses the compact create labels and supports quick due dates', () => {
    render(<TaskForm taskLists={[]} onCancel={vi.fn()} onSaved={vi.fn()} />)

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

  it('uses the shared form to create a subtask under its parent', async () => {
    const saved = { id: 'subtask-1' }
    const onSaved = vi.fn()
    createSubtask.mockResolvedValue(saved)

    render(
      <TaskForm
        taskLists={[]}
        parentTaskId="parent-1"
        onCancel={vi.fn()}
        onSaved={onSaved}
      />
    )

    fireEvent.change(
      screen.getByPlaceholderText('form.createTitlePlaceholder'),
      { target: { value: 'Write changelog' } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'subtasks.create' }))

    await waitFor(() =>
      expect(createSubtask).toHaveBeenCalledWith({
        taskId: 'parent-1',
        payload: expect.objectContaining({ title: 'Write changelog' }),
      })
    )
    expect(createTask).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith(saved)
  })
})

const localDateValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
