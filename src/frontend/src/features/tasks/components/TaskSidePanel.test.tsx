import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { TaskDetailPanel } from './TaskSidePanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTask: () => ({ data: undefined, isLoading: false, error: null }),
  usePatchTask: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

vi.mock('./TaskCollaborationSections', () => ({
  TaskAttachmentsSection: () => null,
  TaskCommentsSection: () => null,
  TaskHistorySection: () => null,
  TaskSubtasksSection: () => null,
}))

const task: ApiTask = {
  id: 'task-1',
  title: 'Prepare release',
  description: 'Run the release checks',
  creator: { id: 'creator', full_name: 'Creator', short_name: null },
  assignee: { id: 'assignee', full_name: 'Assignee', short_name: null },
  status: 'todo',
  priority: 'high',
  labels: [],
  start_date: '2026-08-21',
  due_date: '2026-08-31',
  completed_at: null,
  source_action_item_id: null,
  source_room_id: null,
  source_room_name: null,
  parent_id: null,
  subtask_count: 0,
  completed_subtask_count: 0,
  can_edit: false,
  can_update_status: false,
  time_state: null,
  created_at: '2026-08-21T08:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
}

describe('TaskDetailPanel', () => {
  it('renders start and due dates as separate properties', () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={task}
        labels={[]}
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
  })
})
