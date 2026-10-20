import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchApi } = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi }))

import { pullAiCallHistory, pushAiCallHistory } from './sync'

describe('AI call history sync', () => {
  beforeEach(() => {
    fetchApi.mockReset()
    localStorage.clear()
  })

  it('maps server snapshots to local records', async () => {
    fetchApi.mockResolvedValue({
      conversations: [{
        id: 'remote-1',
        client_id: 'local-1',
        started_at: '2026-10-20T10:00:00Z',
        ended_at: '2026-10-20T10:01:00Z',
        messages: [
          { id: 'm1', client_id: 'm1', position: 0, role: 'user', text: 'hi' },
        ],
      }],
    })
    const records = await pullAiCallHistory()
    expect(records).toEqual([{
      id: 'local-1',
      remoteId: 'remote-1',
      startedAt: Date.parse('2026-10-20T10:00:00Z'),
      seconds: 60,
      rows: [{ id: 'm1', role: 'user', text: 'hi' }],
    }])
  })

  it('uploads a stable snapshot and returns the server id', async () => {
    fetchApi.mockResolvedValue({ id: 'remote-1' })
    const remote = await pushAiCallHistory({
      id: 'local-1',
      startedAt: 1000,
      seconds: 2,
      rows: [{ id: 'm1', role: 'user', text: 'hi' }],
    })
    expect(remote).toBe('remote-1')
    expect(fetchApi).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchApi.mock.calls[0][1].body)
    expect(body.client_id).toBe('local-1')
    expect(body.messages[0]).toMatchObject({
      client_id: 'm1',
      position: 0,
      role: 'user',
      text: 'hi',
    })
    expect(localStorage.getItem('we-meet:ai-call-device')).toBeTruthy()
  })
})
