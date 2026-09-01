import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import zhTasks from '@/locales/zh/tasks.json'

import type { ApiTask, ApiTaskList } from '../api/ApiTask'
import { TaskForm } from './TaskForm'

const { createTask } = vi.hoisted(() => ({
  createTask: vi.fn(),
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
  useTaskSettings: () => ({
    data: {
      daily_reminder_enabled: true,
      overdue_marker_enabled: true,
      default_reminder_minutes: 1440,
    },
  }),
}))

vi.mock('@/features/auth', () => ({
  useUser: () => ({
    user: {
      id: 'current-user',
      full_name: 'W009',
      email: 'w009@example.com',
      avatar_url: '/me.png',
    },
  }),
}))

describe('TaskForm create mode', () => {
  beforeEach(() => {
    createTask.mockReset()
  })

  it('uses the compact create labels and supports quick due dates', () => {
    const { container } = render(
      <TaskForm taskLists={[]} onCancel={vi.fn()} onSaved={vi.fn()} />
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
    expect(screen.getAllByText('priorities.medium')).toHaveLength(2)
    expect(screen.queryByText('priorities.none')).not.toBeInTheDocument()
    expect(screen.queryByText('form.assigneeSelf')).not.toBeInTheDocument()
    expect(screen.getByText('W009')).toBeInTheDocument()
    expect(container.querySelector('img[src="/me.png"]')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'assignees.add' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'followers.add' })
    ).toBeInTheDocument()
    expect(screen.getByText('taskReminder.title')).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'taskReminder.enabled' })
    ).toBeChecked()
    expect(
      screen.getByRole('combobox', { name: 'taskReminder.timing' })
    ).toHaveValue('default')

    fireEvent.click(screen.getByRole('button', { name: 'form.today' }))
    expect(screen.getByLabelText('form.dueDate')).toHaveValue(
      localDateValue(new Date())
    )
  })

  it('creates the task with the selected personal reminder', async () => {
    createTask.mockResolvedValue({ id: 'reminded-task' })
    render(<TaskForm taskLists={[]} onCancel={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(
      screen.getByPlaceholderText('form.createTitlePlaceholder'),
      { target: { value: 'Prepare reminder' } }
    )
    fireEvent.change(
      screen.getByRole('combobox', { name: 'taskReminder.timing' }),
      { target: { value: '4320' } }
    )
    fireEvent.click(
      screen.getByRole('switch', { name: 'taskReminder.enabled' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'workspace.createSubmit' })
    )

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          reminder: { enabled: false, reminder_minutes: 4320 },
        })
      )
    )
  })

  it('uses the expected Chinese create action labels', () => {
    expect(zhTasks.workspace.createCancel).toBe('取消')
    expect(zhTasks.workspace.createSubmit).toBe('新建')
    expect(zhTasks.taskLists.none).toBe('默认清单')
    expect(zhTasks.taskListGroups.none).toBe('默认分组')
    expect(zhTasks.groups.ungrouped).toBe('默认分组')
  })

  it('serializes an interval and occurrence limit for a recurring task', async () => {
    createTask.mockResolvedValue({ id: 'recurring-task' })
    render(<TaskForm taskLists={[]} onCancel={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(
      screen.getByPlaceholderText('form.createTitlePlaceholder'),
      { target: { value: 'Monthly close' } }
    )
    fireEvent.click(screen.getByLabelText('recurrence.label'))
    fireEvent.click(
      await screen.findByRole('option', { name: 'recurrence.monthly' })
    )
    fireEvent.change(screen.getByRole('spinbutton'), {
      target: { value: '2' },
    })
    fireEvent.click(screen.getByLabelText('recurrence.ends'))
    fireEvent.click(
      await screen.findByRole('option', { name: 'recurrence.endCount' })
    )
    fireEvent.change(screen.getByLabelText('recurrence.count'), {
      target: { value: '6' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'workspace.createSubmit' })
    )

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Monthly close',
          recurrence: {
            frequency: 'monthly',
            interval: 2,
            end_date: null,
            max_occurrences: 6,
          },
        })
      )
    )
  })

  it('inherits every editable parameter except the title from its parent', async () => {
    const parentAssignee = {
      id: 'parent-assignee',
      full_name: 'Parent assignee',
      short_name: null,
      email: 'assignee@example.com',
      avatar_url: '/assignee.png',
    }
    const parentFollower = {
      id: 'parent-follower',
      full_name: 'Parent follower',
      short_name: null,
      email: 'follower@example.com',
      avatar_url: '/follower.png',
    }
    const taskLists = [
      {
        id: 'list-1',
        name: 'Product',
        groups: [{ id: 'group-1', name: 'Delivery', sort_order: 0 }],
      },
    ] as ApiTaskList[]
    const parentTask = {
      id: 'parent-1',
      title: 'Parent title must not be inherited',
      description: 'Inherited description',
      assignee: parentAssignee,
      assignees: [parentAssignee],
      followers: [parentFollower],
      priority: 'urgent',
      task_list: { id: 'list-1', name: 'Product', color: 'blue' },
      group: { id: 'group-1', name: 'Delivery', sort_order: 0 },
      start_date: '2026-08-25',
      due_date: '2026-08-30',
    } as ApiTask
    createTask.mockResolvedValue(parentTask)

    render(
      <TaskForm
        taskLists={taskLists}
        parentTask={parentTask}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    const titleInput = screen.getByPlaceholderText(
      'form.createTitlePlaceholder'
    )
    expect(titleInput).toHaveValue('')
    expect(
      screen.getByPlaceholderText('form.createDescriptionPlaceholder')
    ).toHaveValue('Inherited description')
    expect(screen.getByText('Parent assignee')).toBeInTheDocument()
    expect(screen.getByText('Parent follower')).toBeInTheDocument()
    expect(screen.getByLabelText('form.dueDate')).toHaveValue('2026-08-30')

    fireEvent.change(titleInput, { target: { value: 'Child task' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'workspace.createSubmit' })
    )

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith({
        title: 'Child task',
        description: 'Inherited description',
        assignee_ids: ['parent-assignee'],
        follower_ids: ['parent-follower'],
        priority: 'urgent',
        task_list_id: 'list-1',
        group_id: 'group-1',
        start_date: '2026-08-25',
        due_date: '2026-08-30',
        parent_id: 'parent-1',
        reminder: { enabled: false, reminder_minutes: null },
      })
    )
  })
})

const localDateValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
