import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from './ApiTask'

import {
  buildTasksUrl,
  getNextTaskActivityPageParam,
  getNextTasksPageParam,
  usePatchTask,
} from './fetchTasks'

const { fetchApiMock } = vi.hoisted(() => ({ fetchApiMock: vi.fn() }))

vi.mock('@/api/fetchApi', () => ({ fetchApi: fetchApiMock }))

beforeEach(() => fetchApiMock.mockReset())

describe('buildTasksUrl', () => {
  it('combines workspace and task list filters', () => {
    expect(
      buildTasksUrl('created', 'open', 'due_today', 'urgent', 'list/id')
    ).toBe(
      'tasks/?scope=created&status=open&time=due_today&priority=urgent&task_list=list%2Fid&group=all&page_size=50'
    )
  })

  it('adds a validated ordering to the first page request', () => {
    expect(
      buildTasksUrl(
        'all',
        'open',
        'all',
        'all',
        'all',
        'group/id',
        '-created_at'
      )
    ).toBe(
      'tasks/?scope=all&status=open&time=all&priority=all&task_list=all&group=group%2Fid&ordering=-created_at&page_size=50'
    )
  })
})

describe('getNextTasksPageParam', () => {
  it('continues with the backend next page URL and stops at the last page', () => {
    const page = {
      count: 51,
      previous: null,
      results: [],
    }

    expect(
      getNextTasksPageParam({
        ...page,
        next: 'https://meet.test/api/v1.0/tasks/?page=2',
      })
    ).toBe('https://meet.test/api/v1.0/tasks/?page=2')
    expect(getNextTasksPageParam({ ...page, next: null })).toBeUndefined()
  })
})

describe('getNextTaskActivityPageParam', () => {
  it('continues the activity feed with the backend next page URL', () => {
    const page = {
      count: 51,
      previous: null,
      results: [],
    }

    expect(
      getNextTaskActivityPageParam({
        ...page,
        next: 'https://meet.test/api/v1.0/tasks/activity/?page=2',
      })
    ).toBe('https://meet.test/api/v1.0/tasks/activity/?page=2')
    expect(
      getNextTaskActivityPageParam({ ...page, next: null })
    ).toBeUndefined()
  })
})

describe('usePatchTask', () => {
  it('refreshes custom-group counts after moving a task', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    fetchApiMock.mockResolvedValue({ id: 'task-1' } as ApiTask)

    const { result } = renderHook(() => usePatchTask(), { wrapper })
    await act(() =>
      result.current.mutateAsync({
        taskId: 'task-1',
        patch: { group_id: 'group-2' },
      })
    )

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['task-groups'],
    })
  })
})
