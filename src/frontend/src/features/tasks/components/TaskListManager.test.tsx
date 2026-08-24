import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TaskListManager } from './TaskListManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/fetchTasks', () => ({
  useCreateTaskList: () => ({
    mutateAsync: vi.fn(),
    error: null,
    isPending: false,
  }),
}))

describe('TaskListManager', () => {
  it('shows only the create form without an existing task-list section', () => {
    render(<TaskListManager taskListGroups={[]} onCancel={vi.fn()} />)

    expect(screen.getByText('taskLists.name')).toBeInTheDocument()
    expect(screen.getByText('taskListGroups.field')).toBeInTheDocument()
    expect(screen.queryByText('taskLists.title')).not.toBeInTheDocument()
  })
})
