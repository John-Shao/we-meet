import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import { SummaryAutomationControl } from './SummaryAutomationControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let client: QueryClient
let state: {
  enabled: boolean
  revision: number
  state: string
  can_control: boolean
  available: boolean
  error_code: string
}
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SummaryAutomationControl recordId="record" viewerId="viewer" />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  vi.resetAllMocks()
  state = {
    enabled: false,
    revision: 0,
    state: 'off',
    can_control: true,
    available: true,
    error_code: '',
  }
  const receipts = new Map<string, typeof state>()
  mocks.fetchApi.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      const key = options.headers['Idempotency-Key']
      const replayed = receipts.has(key)
      if (!replayed) {
        state = {
          ...state,
          enabled: JSON.parse(options.body).enabled,
          revision: state.revision + 1,
        }
        receipts.set(key, state)
      }
      return {
        command_id: '11111111-1111-4111-8111-111111111111',
        replayed,
        result: receipts.get(key),
        current: state,
      }
    }
    return state
  })
})
afterEach(() => client?.clear())

describe('Automatic summary consent', () => {
  it('keeps a malformed success pending and accepts the frozen receipt after a newer stop', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let writes = 0
    mocks.fetchApi.mockImplementation(async (url, options) => {
      const result = await fallback(url, options)
      if (options?.method === 'POST' && ++writes === 1)
        return { current: state }
      return result
    })
    const first = show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.automation.start' })
    )
    await screen.findByText('recordAi.uncertain')
    first.unmount()
    client.clear()
    state = { ...state, enabled: false, revision: 2 }
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.resubmit' })
    )
    await screen.findByRole('button', { name: 'recordAi.automation.start' })
    expect(posts()).toHaveLength(2)
    expect(posts()[0][1].body).toBe(posts()[1][1].body)
    expect(posts()[0][1].headers).toEqual(posts()[1][1].headers)
    expect(state.enabled).toBe(false)
  })
  it('recovers an unknown enable after remount without sending on mount or toggling it off', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let failed = false
    mocks.fetchApi.mockImplementation(async (url, options) => {
      if (options?.method === 'POST' && !failed) {
        failed = true
        await fallback(url, options)
        throw new ApiError(408, {})
      }
      return fallback(url, options)
    })
    const first = show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.automation.start' })
    )
    await screen.findByText('recordAi.uncertain')
    first.unmount()
    client.clear()
    show()
    const check = await screen.findByRole('button', {
      name: 'recordAi.resubmit',
    })
    expect(posts()).toHaveLength(1)
    fireEvent.click(check)
    await screen.findByRole('button', { name: 'recordAi.automation.stop' })
    expect(posts()[0][1].body).toBe(posts()[1][1].body)
    expect(posts()[0][1].headers).toEqual(posts()[1][1].headers)
  })
  it('does not start on mount and sends explicit revisioned consent', async () => {
    show()
    const start = await screen.findByRole('button', {
      name: 'recordAi.automation.start',
    })
    expect(posts()).toHaveLength(0)
    fireEvent.click(start)
    await screen.findByRole('button', { name: 'recordAi.automation.stop' })
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0][1].body)).toEqual({
      enabled: true,
      expected_revision: 0,
    })
  })

  it('retains identical consent after an uncertain result without reversing the toggle', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let failed = false
    mocks.fetchApi.mockImplementation(async (url, options) => {
      if (options?.method === 'POST' && !failed) {
        failed = true
        await fallback(url, options)
        throw new TypeError('connection lost after commit')
      }
      return fallback(url, options)
    })
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.automation.start' })
    )
    await screen.findByText('recordAi.uncertain')
    fireEvent.click(screen.getByRole('button', { name: 'recordAi.resubmit' }))
    await screen.findByRole('button', { name: 'recordAi.automation.stop' })
    expect(posts()).toHaveLength(2)
    expect(posts()[0][1]).toEqual(posts()[1][1])
  })

  it('allows stopping after rollout is disabled', async () => {
    state = { ...state, enabled: true, available: false, revision: 4 }
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.automation.stop' })
    )
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(JSON.parse(posts()[0][1].body)).toEqual({
      enabled: false,
      expected_revision: 4,
    })
  })

  it('does not expose controls to summary-only readers', async () => {
    state.can_control = false
    show()
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalled())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(posts()).toHaveLength(0)
  })

  it('discards a conflicting intent so the next click uses refreshed state', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let failed = false
    mocks.fetchApi.mockImplementation(async (url, options) => {
      if (options?.method === 'POST' && !failed) {
        failed = true
        state = { ...state, enabled: true, revision: 2 }
        throw new ApiError(409, {})
      }
      return fallback(url, options)
    })
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.automation.start' })
    )
    await screen.findByText('recordAi.conflict')
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.automation.stop' })
    )
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(JSON.parse(posts()[1][1].body)).toEqual({
      enabled: false,
      expected_revision: 2,
    })
  })
})
