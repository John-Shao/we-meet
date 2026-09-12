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
  vi.resetAllMocks()
  state = {
    enabled: false,
    revision: 0,
    state: 'off',
    can_control: true,
    available: true,
  }
  mocks.fetchApi.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      state = {
        ...state,
        enabled: JSON.parse(options.body).enabled,
        revision: state.revision + 1,
      }
      return { current: state }
    }
    return state
  })
})
afterEach(() => client?.clear())

describe('Automatic summary consent', () => {
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
