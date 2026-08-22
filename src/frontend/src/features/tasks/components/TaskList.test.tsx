import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { TaskList } from './TaskList'

const mutate = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  usePatchTask: () => ({ mutate, isPending: false }),
}))

const task: ApiTask = {
  id: 'task-1',
  title: 'Prepare release',
  description: 'Run the release checks',
  creator: { id: 'creator', full_name: 'Creator', short_name: null },
  assignee: { id: 'assignee', full_name: 'Assignee', short_name: null },
  status: 'todo',
  priority: 'high',
  labels: [
    {
      id: 'label-1',
      name: 'Release',
      color: 'blue',
      can_manage: true,
      created_at: '2026-08-21T08:00:00Z',
      updated_at: '2026-08-21T08:00:00Z',
    },
  ],
  start_date: '2026-08-21',
  due_date: '2026-08-22',
  completed_at: null,
  source_action_item_id: null,
  source_room_id: 'meeting-1',
  source_room_name: 'Weekly sync',
  parent_id: null,
  subtask_count: 2,
  completed_subtask_count: 1,
  can_edit: false,
  can_update_status: true,
  time_state: null,
  created_at: '2026-08-21T08:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
}

describe('TaskList', () => {
  it('renders desktop and mobile task representations with semantic metadata', () => {
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    expect(screen.getAllByText('Prepare release')).toHaveLength(2)
    expect(screen.getAllByText('priorities.high')).toHaveLength(2)
    expect(screen.getAllByText('Release')).toHaveLength(2)
  })

  it('opens a focused row with Enter and performs its permitted quick action', () => {
    const onOpen = vi.fn()
    render(<TaskList tasks={[task]} onOpen={onOpen} registerRow={vi.fn()} />)

    fireEvent.keyDown(screen.getAllByLabelText('workspace.openTask')[0], {
      key: 'Enter',
    })
    expect(onOpen).toHaveBeenCalledWith(task)

    fireEvent.click(screen.getAllByLabelText('workspace.quickComplete')[0])
    expect(mutate).toHaveBeenCalledWith({
      taskId: 'task-1',
      patch: { status: 'completed' },
    })
  })
})
