import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunPendingApprovals } from './RunPendingApprovals'
import type { PendingLocalApproval } from '../../../../../../desktop/src/work/bridge'

const state = vi.hoisted(() => ({
  phases: ['R0a', 'R0b'] as string[],
  list: vi.fn(),
  open: vi.fn(),
  decided: undefined as
    | ((value: { approvalId: string; runId: string }) => void)
    | undefined,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'zh' },
  }),
}))
vi.mock('../../r0a/api/queries', () => ({
  useWorkBootstrap: () => ({ data: { phases: state.phases } }),
}))

const approval = (
  overrides: Partial<PendingLocalApproval> = {}
): PendingLocalApproval => ({
  approvalId: '33333333-3333-4333-8333-333333333333',
  taskId: '99999999-9999-4999-8999-999999999999',
  runId: '55555555-5555-4555-8555-555555555555',
  operationId: '44444444-4444-4444-8444-444444444444',
  actionKind: 'artifact.write',
  risk: 'local_write',
  expiresAt: '2027-01-01T00:00:00Z',
  ...overrides,
})

const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return render(
    <QueryClientProvider client={client}>
      <RunPendingApprovals taskId="99999999-9999-4999-8999-999999999999" />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  state.phases = ['R0a', 'R0b']
  state.list.mockReset().mockResolvedValue({
    status: 'available',
    approvals: [
      approval(),
      approval({
        approvalId: '77777777-7777-4777-8777-777777777777',
        taskId: '88888888-8888-4888-8888-888888888888',
        actionKind: 'model.request',
      }),
    ],
  })
  state.open.mockReset().mockResolvedValue({ status: 'opened' })
  state.decided = undefined
  Object.defineProperty(window, 'weMeetDesktop', {
    configurable: true,
    value: {
      work: {
        listPendingLocalApprovals: state.list,
        openLocalContent: state.open,
        onApprovalDecided: (callback: typeof state.decided) => {
          state.decided = callback
          return () => {
            state.decided = undefined
          }
        },
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'weMeetDesktop')
})

describe('RunPendingApprovals', () => {
  it('shows only this task and opens the approval body through the secure bridge', async () => {
    setup()
    expect(await screen.findByText('task.pendingApprovals')).toBeTruthy()
    expect(screen.getByText('artifact.write')).toBeTruthy()
    expect(screen.queryByText('model.request')).toBeNull()
    expect(screen.getByText('local_write')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'task.pendingApprovalReview' })
    )
    await waitFor(() =>
      expect(state.open).toHaveBeenCalledWith(
        'approval',
        '33333333-3333-4333-8333-333333333333'
      )
    )
  })

  it('refreshes after the main process reports a decision', async () => {
    setup()
    await screen.findByText('task.pendingApprovals')
    expect(state.list).toHaveBeenCalledTimes(1)
    state.decided?.({
      approvalId: '33333333-3333-4333-8333-333333333333',
      runId: '55555555-5555-4555-8555-555555555555',
    })
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2))
  })

  it('does not read the Bearer face before the R0b phase is enabled', async () => {
    state.phases = ['R0a']
    const { container } = setup()
    expect(container).toBeEmptyDOMElement()
    expect(state.list).not.toHaveBeenCalled()
  })

  it('reports a refused or unavailable local body without falling back to renderer text', async () => {
    state.open.mockResolvedValue({ status: 'not_on_this_device' })
    setup()
    fireEvent.click(
      await screen.findByRole('button', { name: 'task.pendingApprovalReview' })
    )
    expect(
      await screen.findByText('task.pendingApprovalOpenFailed')
    ).toBeTruthy()
  })
})
