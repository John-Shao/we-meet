import { describe, expect, it } from 'vitest'

import { buildTasksUrl } from './fetchTasks'

describe('buildTasksUrl', () => {
  it('combines scope, time, priority and label filters', () => {
    expect(buildTasksUrl('created', 'due_today', 'urgent', 'label/id')).toBe(
      'tasks/?scope=created&time=due_today&priority=urgent&label=label%2Fid&page_size=100'
    )
  })
})
