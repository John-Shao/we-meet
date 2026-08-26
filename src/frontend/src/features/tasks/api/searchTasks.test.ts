import { describe, expect, it } from 'vitest'

import { buildTaskSearchUrl, EMPTY_TASK_SEARCH_FILTERS } from './searchTasks'

describe('buildTaskSearchUrl', () => {
  it('serializes a minimal global task search', () => {
    expect(
      buildTaskSearchUrl('  launch plan  ', EMPTY_TASK_SEARCH_FILTERS, 5)
    ).toBe('tasks/?scope=all&status=all&q=launch+plan&page_size=5')
  })

  it('sorts and deduplicates person filters for a stable cache key', () => {
    expect(
      buildTaskSearchUrl(
        '计划',
        {
          creatorIds: ['c', 'a', 'c'],
          assigneeIds: ['b', 'a'],
          followerIds: ['z', 'z'],
          status: 'todo',
          due: 'this_week',
        },
        20
      )
    ).toBe(
      'tasks/?scope=all&status=todo&q=%E8%AE%A1%E5%88%92&creator_ids=a%2Cc&assignee_ids=a%2Cb&follower_ids=z&due=this_week&page_size=20'
    )
  })
})
