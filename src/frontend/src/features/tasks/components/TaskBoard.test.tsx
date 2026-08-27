import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { TaskBoard } from './TaskBoard'

const mutateAsync = vi.fn()
const notifyAction = vi.fn()
const notifyFailure = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  usePatchTask: () => ({ mutateAsync }),
}))

vi.mock('./TaskActionFeedbackContext', () => ({
  useTaskActionFeedback: () => ({ notifyAction, notifyFailure }),
}))

const task: ApiTask = {
  id: 'task-1',
  title: 'Release',
  description: '',
  creator: {
    id: 'creator',
    full_name: 'Creator',
    short_name: null,
    avatar_url: '',
  },
  assignee: null,
  assignees: [],
  followers: [],
  status: 'todo',
  priority: 'medium',
  task_list: null,
  group: null,
  parent_id: null,
  depth: 0,
  ancestor_path: [{ id: 'task-1', title: 'Release', depth: 0 }],
  descendant_progress: { completed: 0, total: 0 },
  can_create_subtasks: true,
  position: 0,
  start_date: null,
  due_date: null,
  completed_at: null,
  recurrence: null,
  source_action_item_id: null,
  source_room_id: null,
  source_room_name: null,
  can_edit: true,
  can_update_status: true,
  can_delete: true,
  can_comment: true,
  can_manage_attachments: true,
  can_manage_followers: true,
  is_following: false,
  time_state: null,
  created_at: '2026-08-27T08:00:00Z',
  updated_at: '2026-08-27T08:00:00Z',
}

describe('TaskBoard', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
    mutateAsync.mockResolvedValue({ ...task, status: 'completed' })
    notifyAction.mockReset()
    notifyFailure.mockReset()
  })

  it('reports an undoable status change after a successful drop', async () => {
    render(<TaskBoard tasks={[task]} onOpen={vi.fn()} />)
    const values = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) || '',
    }

    fireEvent.dragStart(screen.getByRole('button', { name: /Release/ }), {
      dataTransfer,
    })
    fireEvent.drop(screen.getByText('statuses.completed').closest('section')!, {
      dataTransfer,
    })

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { status: 'completed' },
      })
    )
    expect(notifyAction).toHaveBeenCalledWith({
      taskId: task.id,
      title: task.title,
      kind: 'completed',
      undoPatch: { status: 'todo' },
    })
  })
})
