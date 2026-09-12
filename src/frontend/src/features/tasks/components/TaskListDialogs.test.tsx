import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiTaskList } from '../api/ApiTask'
import { TaskListDeleteDialog } from './TaskListDialogs'

const { destroy, refetch, impact } = vi.hoisted(() => ({
  destroy: vi.fn(),
  refetch: vi.fn(),
  impact: {
    data: {
      count: 1,
      token: 'review-1',
      tasks: [{ id: 'task-1', title: 'Unassigned work' }],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'owner' } }),
}))
vi.mock('@/features/contacts', () => ({
  ContactPicker: () => null,
  MemberAvatar: () => null,
}))
vi.mock('../api/fetchTasks', () => ({
  useDestroyTaskList: () => ({
    mutateAsync: destroy,
    isPending: false,
    error: null,
  }),
  useTaskListDeletionImpact: () => ({ ...impact, refetch }),
}))

const taskList = { id: 'list-1', name: 'Delivery' } as ApiTaskList

describe('TaskListDeleteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destroy.mockResolvedValue(undefined)
    impact.data.token = 'review-1'
    impact.isFetching = false
    impact.isError = false
  })

  it('keeps tasks by default and sends the reviewed token only after opting in', async () => {
    const onDeleted = vi.fn()
    render(
      <TaskListDeleteDialog
        taskList={taskList}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />
    )
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByText('Unassigned work')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'taskLists.delete' }))
    await waitFor(() =>
      expect(destroy).toHaveBeenCalledWith({
        taskListId: 'list-1',
        deleteUnassigned: true,
        confirmationToken: 'review-1',
      })
    )
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('blocks a stale preview until the user reviews and selects it again', () => {
    const props = { taskList, onClose: vi.fn(), onDeleted: vi.fn() }
    const { rerender } = render(<TaskListDeleteDialog {...props} />)
    fireEvent.click(screen.getByRole('checkbox'))
    impact.data.token = 'review-2'
    rerender(<TaskListDeleteDialog {...props} />)
    expect(
      screen.getByRole('button', { name: 'taskLists.delete' })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(
      screen.getByRole('button', { name: 'taskLists.delete' })
    ).toBeEnabled()
    expect(destroy).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and resets the destructive option after a conflict', async () => {
    destroy.mockRejectedValue(new Error('Scope changed'))
    const onDeleted = vi.fn()
    render(
      <TaskListDeleteDialog
        taskList={taskList}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'taskLists.delete' }))
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('allows keeping tasks when the optional deletion preview fails', async () => {
    impact.isError = true
    render(
      <TaskListDeleteDialog
        taskList={taskList}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    expect(screen.getByRole('checkbox')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'taskLists.delete' }))
    await waitFor(() =>
      expect(destroy).toHaveBeenCalledWith({
        taskListId: 'list-1',
        deleteUnassigned: false,
        confirmationToken: undefined,
      })
    )
  })
})
