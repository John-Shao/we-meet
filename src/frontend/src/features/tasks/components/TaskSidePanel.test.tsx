import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { TaskDetailPanel } from './TaskSidePanel'

const { confirm, deleteMutateAsync, mutate, mutateAsync } = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
  deleteMutateAsync: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTask: () => ({ data: undefined, isLoading: false, error: null }),
  useDeleteTask: () => ({
    mutateAsync: deleteMutateAsync,
    isPending: false,
    error: null,
  }),
  usePatchTask: () => ({
    mutate,
    mutateAsync,
    isPending: false,
    error: null,
  }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ confirm }),
}))

vi.mock('./TaskCollaborationSections', () => ({
  TaskAttachmentsSection: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="attachments" data-read-only={String(Boolean(readOnly))} />
  ),
  TaskCommentsSection: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="comments" data-read-only={String(Boolean(readOnly))} />
  ),
  TaskHistorySection: () => null,
}))

const task: ApiTask = {
  id: 'task-1',
  title: 'Prepare release',
  description: 'Run the release checks',
  creator: {
    id: 'creator',
    full_name: 'Creator',
    short_name: null,
    avatar_url: '/creator.png',
  },
  assignee: {
    id: 'assignee',
    full_name: 'Assignee',
    short_name: null,
    avatar_url: '/assignee.png',
  },
  status: 'todo',
  priority: 'high',
  task_list: null,
  group: null,
  position: 0,
  start_date: '2026-08-21',
  due_date: '2026-08-31',
  completed_at: null,
  source_action_item_id: null,
  source_room_id: null,
  source_room_name: null,
  can_edit: false,
  can_update_status: false,
  can_delete: false,
  can_comment: false,
  can_manage_attachments: false,
  time_state: null,
  created_at: '2026-08-21T08:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
}

describe('TaskDetailPanel', () => {
  beforeEach(() => {
    mutate.mockClear()
    mutateAsync.mockClear()
    deleteMutateAsync.mockClear()
    confirm.mockClear()
  })

  it('renders start and due dates as separate properties', () => {
    const { container } = render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={task}
        taskLists={[]}
        onClose={vi.fn()}
      />
    )

    const startDateLabel = screen.getByText('meta.startDate', {
      selector: 'dt',
    })
    const dueDateLabel = screen.getByText('meta.dueDate', { selector: 'dt' })

    expect(startDateLabel.parentElement).toHaveTextContent('Aug 21, 2026')
    expect(dueDateLabel.parentElement).toHaveTextContent('Aug 31, 2026')
    expect(
      screen.queryByText('meta.startDate / meta.dueDate')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^actions\.edit / })
    ).not.toBeInTheDocument()
    expect(container.querySelector('img[src="/assignee.png"]')).toBeTruthy()
    expect(container.querySelector('img[src="/creator.png"]')).toBeTruthy()
  })

  it('edits each creator-managed field inline without a global edit page', async () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{ ...task, can_edit: true }}
        taskLists={[]}
        onClose={vi.fn()}
      />
    )

    expect(
      screen.queryByRole('button', { name: 'actions.edit' })
    ).not.toBeInTheDocument()
    const editableFields = [
      'form.title',
      'meta.assignee',
      'meta.startDate',
      'meta.dueDate',
      'form.priority',
      'form.description',
      'taskLists.field',
    ]
    editableFields.forEach((field) => {
      expect(
        screen.getByRole('button', { name: `actions.edit ${field}` })
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'actions.edit meta.creator' })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'actions.edit form.title' })
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'form.title' }), {
      target: { value: 'Ship release' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { title: 'Ship release' },
      })
    )
  })

  it('uses dedicated collaboration capabilities for comments and attachments', () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_update_status: true,
          can_comment: true,
          can_manage_attachments: false,
        }}
        taskLists={[]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('comments')).toHaveAttribute(
      'data-read-only',
      'false'
    )
    expect(screen.getByTestId('attachments')).toHaveAttribute(
      'data-read-only',
      'true'
    )
  })

  it('deletes an editable task after confirmation', async () => {
    const onClose = vi.fn()
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{ ...task, can_delete: true }}
        taskLists={[]}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'actions.delete' }))

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith(task.id))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
