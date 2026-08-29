import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskActivityDialog } from './TaskActivityDialog'

const { activityState } = vi.hoisted(() => ({
  activityState: {
    current: {
      data: {
        pages: [
          {
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                id: 'activity-1',
                task_id: 'task-1',
                task_title: 'Ship Android tasks',
                actor: {
                  id: 'user-1',
                  full_name: 'Alice',
                  short_name: null,
                  avatar_url: '',
                },
                event: 'created' as const,
                changes: {},
                created_at: '2026-08-29T08:00:00Z',
              },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
      refetch: vi.fn(),
    },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.title ? `${key}:${values.title}` : key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTaskActivityFeed: () => activityState.current,
}))

vi.mock('../taskActivityMessage', () => ({
  taskActivityMessage: () => 'Alice created the task',
}))

describe('TaskActivityDialog', () => {
  beforeEach(() => {
    activityState.current.hasNextPage = false
    activityState.current.fetchNextPage.mockClear()
  })

  it('shows cross-task activity and opens the selected task', () => {
    const onOpenTask = vi.fn()
    render(<TaskActivityDialog onClose={vi.fn()} onOpenTask={onOpenTask} />)

    expect(screen.getByText('Ship Android tasks')).toBeVisible()
    expect(screen.getByText('Alice created the task')).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'activity.openTask:Ship Android tasks',
      })
    )
    expect(onOpenTask).toHaveBeenCalledWith('task-1')
  })

  it('loads the next page when more activity is available', () => {
    activityState.current.hasNextPage = true
    render(<TaskActivityDialog onClose={vi.fn()} onOpenTask={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'activity.loadMore' }))
    expect(activityState.current.fetchNextPage).toHaveBeenCalledOnce()
  })
})
