import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from '@/api/fetchApi'

import { fetchTaskSettings, patchTaskSettings } from './fetchTasks'

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
})
