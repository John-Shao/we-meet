import { describe, expect, it } from 'vitest'

import { buildTasksUrl, getNextTasksPageParam } from './fetchTasks'

describe('buildTasksUrl', () => {
  it('combines workspace and task list filters', () => {
    expect(
      buildTasksUrl(
        'created',
        'open',
        'due_today',
        'urgent',
        'label/id',
        'list/id'
      )
    ).toBe(
      'tasks/?scope=created&status=open&time=due_today&priority=urgent&label=label%2Fid&task_list=list%2Fid&page_size=50'
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
