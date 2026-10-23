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
      conversations: [
        {
          id: 'remote-1',
          client_id: 'local-1',
          started_at: '2026-10-20T10:00:00Z',
          ended_at: '2026-10-20T10:01:00Z',
          messages: [
            {
              id: 'm1',
              client_id: 'm1',
              position: 0,
              role: 'user',
              text: 'hi',
            },
          ],
        },
      ],
    })
    const records = await pullAiCallHistory()
    expect(records).toEqual([
      {
        id: 'local-1',
        remoteId: 'remote-1',
        startedAt: Date.parse('2026-10-20T10:00:00Z'),
        seconds: 60,
        rows: [{ id: 'm1', role: 'user', text: 'hi' }],
      },
    ])
  })

  it('carries title, summary and todos in both directions', async () => {
    fetchApi.mockResolvedValue({
      conversations: [
        {
          id: 'remote-2',
          client_id: 'local-2',
          started_at: '2026-10-20T10:00:00Z',
          ended_at: '2026-10-20T10:01:00Z',
          title: 'Weekly sync',
          summary: 'Discussed roadmap.',
          todos: [{ text: 'Send notes', done: false }],
          messages: [],
        },
      ],
    })
    const records = await pullAiCallHistory()
    expect(records[0]).toMatchObject({
      title: 'Weekly sync',
      summary: 'Discussed roadmap.',
      todos: [{ text: 'Send notes', done: false }],
    })

    fetchApi.mockResolvedValue({ id: 'remote-3' })
    await pushAiCallHistory({
      id: 'local-3',
      startedAt: 1000,
      seconds: 2,
      rows: [],
      title: 'Weekly sync',
      summary: 'Discussed roadmap.',
      todos: [{ text: 'Send notes', done: false }],
    })
    const body = JSON.parse(fetchApi.mock.calls[1][1].body)
    expect(body).toMatchObject({
      title: 'Weekly sync',
      summary: 'Discussed roadmap.',
      todos: [{ text: 'Send notes', done: false }],
    })
  })

  it('drops malformed snapshots instead of rendering invalid dates', async () => {
    fetchApi.mockResolvedValue({
      conversations: [
        {
          id: 'remote-bad',
          client_id: 'local-bad',
          started_at: '',
          ended_at: '',
          messages: [],
        },
        {
          id: 'remote-good',
          client_id: 'local-good',
          started_at: '2026-10-20T10:00:00Z',
          messages: [],
        },
      ],
    })
    const records = await pullAiCallHistory()
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('local-good')
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
