import { describe, expect, it } from 'vitest'

import { buildTasksUrl } from './fetchTasks'

describe('buildTasksUrl', () => {
  it('combines scope, time and priority filters', () => {
    expect(buildTasksUrl('created', 'due_today', 'urgent')).toBe(
      'tasks/?scope=created&time=due_today&priority=urgent&page_size=100'
    )
  })
})
