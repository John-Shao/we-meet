import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from '@/api/fetchApi'

import {
  fetchTaskParentCandidates,
  fetchTaskSettings,
  fetchTaskSubtreeImpact,
  patchTaskSettings,
} from './fetchTasks'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))

beforeEach(() => {
  vi.mocked(fetchApi).mockReset().mockResolvedValue(undefined)
})

describe('task settings API', () => {
  it('loads the current user settings', async () => {
    await fetchTaskSettings()

    expect(fetchApi).toHaveBeenCalledWith('tasks/settings/')
  })

  it('patches only the changed setting', async () => {
    await patchTaskSettings({ overdue_marker_enabled: false })

    expect(fetchApi).toHaveBeenCalledWith('tasks/settings/', {
      method: 'PATCH',
      body: JSON.stringify({ overdue_marker_enabled: false }),
    })
  })

  it('keeps conversation-scoped access on hierarchy helper requests', async () => {
    const signal = new AbortController().signal

    await fetchTaskSubtreeImpact('task/id', 'conversation/id', signal)
    await fetchTaskParentCandidates('task/id', 'conversation/id', signal)

    expect(fetchApi).toHaveBeenNthCalledWith(
      1,
      'tasks/task%2Fid/subtree-impact/?shared_via=conversation%2Fid',
      { signal }
    )
    expect(fetchApi).toHaveBeenNthCalledWith(
      2,
      'tasks/task%2Fid/parent-candidates/?shared_via=conversation%2Fid',
      { signal }
    )
  })
})
