import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkApiError } from '../../r0a/api/client'
import { RunReadonlyGrants } from './RunReadonlyGrants'
import type { WorkReadonlyGrant } from '../api/types'

const state = vi.hoisted(() => ({
  phases: ['R0a', 'R0b'] as string[],
  enabledCalls: [] as boolean[],
  readOnly: false,
  grants: undefined as WorkReadonlyGrant[] | undefined,
  refetch: vi.fn(),
  revoke: vi.fn(),
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
vi.mock('../../r0a/hooks/useReadOnlyViewport', () => ({
  useReadOnlyViewport: () => state.readOnly,
}))
vi.mock('../api/queries', () => ({
  useWorkReadonlyGrants: (_runId: string | undefined, enabled: boolean) => {
    state.enabledCalls.push(enabled)
    return {
      data: state.grants ? { grants: state.grants } : undefined,
      refetch: state.refetch,
    }
  },
  useRevokeWorkReadonlyGrant: () => ({
    mutateAsync: state.revoke,
    isPending: false,
  }),
}))

const grant = (over: Partial<WorkReadonlyGrant> = {}): WorkReadonlyGrant => ({
  id: 'grant-1',
  owner_subject_id: 'browser-user',
  run_id: 'run-1',
  device_id: 'device-1',
  workspace_grant_id: 'workspace-grant-1',
  grant_revision: 2,
  tool_set: ['workspace.read'],
  resource_selector_hash: 'a'.repeat(64),
  policy_epoch: 3,
  access_epoch: 4,
  approval_id: 'approval-1',
  expires_at: '2026-11-23T12:00:00Z',
  status: 'active',
  consumed_count: 2,
  revision: 3,
  created_at: '2026-11-23T10:00:00Z',
  updated_at: '2026-11-23T10:00:00Z',
  ...over,
})

beforeEach(() => {
  state.phases = ['R0a', 'R0b']
  state.enabledCalls = []
  state.readOnly = false
  state.grants = undefined
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('RunReadonlyGrants', () => {
  it('does not read the v2 face when the org lacks the R0b phase', () => {
    state.phases = ['R0a']
    state.grants = [grant()]
    const { container } = render(<RunReadonlyGrants runId="run-1" />)
    expect(state.enabledCalls).toEqual([false])
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a run without grants', () => {
    state.grants = []
    const { container } = render(<RunReadonlyGrants runId="run-1" />)
    expect(state.enabledCalls).toEqual([true])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows tool set, status, expiry and use count, and keeps history rows unrevokable', () => {
    state.grants = [
      grant(),
      grant({ id: 'grant-2', status: 'revoked', tool_set: ['workspace.list'] }),
    ]
    render(<RunReadonlyGrants runId="run-1" />)
    expect(screen.getByText('task.readonlyGrants')).toBeTruthy()
    expect(screen.getByText('workspace.read')).toBeTruthy()
    expect(screen.getByText('task.readonlyGrantsState.active')).toBeTruthy()
    expect(screen.getByText('task.readonlyGrantsState.revoked')).toBeTruthy()
    expect(screen.getAllByText(/task\.readonlyGrantsExpires:/)).toHaveLength(2)
    expect(
      screen.getAllByText('task.readonlyGrantsConsumed:{"times":2}')
    ).toHaveLength(2)
    expect(
      screen.getAllByRole('button', { name: 'task.readonlyGrantsRevoke' })
    ).toHaveLength(1)
  })

  it('revokes only after a second click, against the revision the row was read at', async () => {
    state.grants = [grant()]
    state.revoke.mockResolvedValue({
      grant_id: 'grant-1',
      status: 'revoked',
      revision: 4,
      replayed: false,
    })
    render(<RunReadonlyGrants runId="run-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'task.readonlyGrantsRevoke' })
    )
    expect(state.revoke).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'task.readonlyGrantsConfirmRevoke' })
    )
    await vi.waitFor(() =>
      expect(state.revoke).toHaveBeenCalledWith({
        grantId: 'grant-1',
        body: {
          client_request_id: expect.any(String),
          expected_revision: 3,
        },
      })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('task.readonlyGrantsRevoked')).toBeTruthy()
    )
  })

  it('treats a stale revision or a non-active grant as a refreshed view, not a retry', async () => {
    state.grants = [grant()]
    state.revoke.mockRejectedValue(
      new WorkApiError(409, { code: 'idempotency_key_conflict' })
    )
    render(<RunReadonlyGrants runId="run-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'task.readonlyGrantsRevoke' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'task.readonlyGrantsConfirmRevoke' })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('task.readonlyGrantsConflict')).toBeTruthy()
    )
    expect(state.revoke).toHaveBeenCalledTimes(1)
    expect(state.refetch).toHaveBeenCalled()
  })

  it('also refreshes when the grant is no longer active', async () => {
    state.grants = [grant()]
    state.revoke.mockRejectedValue(
      new WorkApiError(409, {
        code: 'invalid_transition:readonly_approval_grant:not_active',
      })
    )
    render(<RunReadonlyGrants runId="run-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'task.readonlyGrantsRevoke' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'task.readonlyGrantsConfirmRevoke' })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('task.readonlyGrantsConflict')).toBeTruthy()
    )
    expect(state.refetch).toHaveBeenCalled()
  })

  it('offers no revoke affordance below the desktop breakpoint', () => {
    state.readOnly = true
    state.grants = [grant()]
    render(<RunReadonlyGrants runId="run-1" />)
    expect(
      screen.queryByRole('button', { name: 'task.readonlyGrantsRevoke' })
    ).toBeNull()
    expect(screen.getByText('task.readonlyGrantsState.active')).toBeTruthy()
  })
})
