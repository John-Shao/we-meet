import { describe, expect, it } from 'vitest'

import {
  buildTasksUrl,
  getNextTaskActivityPageParam,
  getNextTasksPageParam,
} from './fetchTasks'

describe('buildTasksUrl', () => {
  it('combines workspace and task list filters', () => {
    expect(
      buildTasksUrl('created', 'open', 'due_today', 'urgent', 'list/id')
    ).toBe(
      'tasks/?scope=created&status=open&time=due_today&priority=urgent&task_list=list%2Fid&page_size=50'
    )
  })

  it('adds a validated ordering to the first page request', () => {
    expect(
      buildTasksUrl('all', 'open', 'all', 'all', 'all', '-created_at')
    ).toBe(
      'tasks/?scope=all&status=open&time=all&priority=all&task_list=all&ordering=-created_at&page_size=50'
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
