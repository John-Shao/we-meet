import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useGlobalAsk } from './useGlobalAsk'

const stream = vi.hoisted(() => vi.fn())
vi.mock('@/api/sseStream', () => ({ sseStream: stream }))
beforeEach(() => stream.mockReset())

it('sends the selected meeting date range only after an explicit ask', async () => {
  stream.mockImplementation(async function* () {
    yield {
      type: 'meta',
      citations: [
        { n: 1, kind: 'meeting', record_id: 'record-1', title: 'Meeting' },
      ],
    }
    yield { type: 'delta', text: 'Decision [1]' }
    yield { type: 'done', citations_used: [1] }
  })
  const { result } = renderHook(() => useGlobalAsk())
  expect(stream).not.toHaveBeenCalled()
  await act(() =>
    result.current.ask('decision', {
      scope: 'meetings',
      date_from: '2026-09-01',
      date_to: '2026-09-15',
    })
  )
  expect(stream.mock.calls[0][1].body).toEqual({
    question: 'decision',
    scope: 'meetings',
    date_from: '2026-09-01',
    date_to: '2026-09-15',
  })
  expect(result.current.state.answer).toBe('Decision [1]')
  expect(result.current.state.citations[0].record_id).toBe('record-1')
})

it('clears streamed content and citations when access is revoked', async () => {
  stream.mockImplementation(async function* () {
    yield {
      type: 'meta',
      citations: [{ n: 1, kind: 'meeting', title: 'Private' }],
    }
    yield { type: 'delta', text: 'partial answer' }
    yield { type: 'error', message: 'Meeting access changed. Search again.' }
  })
  const { result } = renderHook(() => useGlobalAsk())
  await act(() => result.current.ask('question'))
  expect(result.current.state.answer).toBe('')
  expect(result.current.state.citations).toEqual([])
  expect(result.current.state.error).toContain('access changed')
})

it('ignores delayed events from a search canceled by changing filters', async () => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  stream.mockImplementation(async function* () {
    await ready
    yield { type: 'delta', text: 'stale content' }
  })
  const { result } = renderHook(() => useGlobalAsk())
  let pending!: Promise<void>
  act(() => {
    pending = result.current.ask('question')
  })
  await waitFor(() => expect(result.current.state.status).toBe('asking'))
  act(() => result.current.reset())
  await act(async () => {
    release()
    await pending
  })
  expect(result.current.state.status).toBe('idle')
  expect(result.current.state.answer).toBe('')
})
