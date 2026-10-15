import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import type { RemoteControlPolicyView } from '../api/adminRemoteControl'
import { AdminRemoteControl } from './RemoteControl'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn(),
  close: vi.fn(),
  confirm: vi.fn(),
  me: { organization: { id: 'org-one' }, is_org_admin: true },
}))
vi.mock('../api/adminRemoteControl', () => ({
  fetchRemoteControlPolicy: mocks.fetch,
  saveRemoteControlPolicy: mocks.save,
  closeRemoteControl: mocks.close,
  fetchRemoteControlMembers: vi.fn(),
}))
vi.mock('../hooks/useAdminMe', () => ({
  useAdminMe: () => ({ data: mocks.me, isPending: false }),
}))
vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ confirm: mocks.confirm }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/features/contacts/components/DirectoryMultiPicker', () => ({
  DirectoryMultiPicker: ({
    onToggle,
    selected,
  }: {
    onToggle: (id: string, name: string) => void
    selected: Map<string, string>
  }) => (
    <button type="button" onClick={() => onToggle('member-one', 'Member One')}>
      {selected.has('member-one') ? 'Remove member' : 'Select member'}
    </button>
  ),
}))

const view: RemoteControlPolicyView = {
  organizationId: 'org-one',
  version: 'a'.repeat(64),
  valid: true,
  globalEnabled: true,
  openSessions: 2,
  members: [],
  policy: {
    enabled: true,
    controllers: null,
    targets: null,
    max_seconds: 1800,
    requests_per_minute: 3,
    rejection_cooldown_seconds: 60,
  },
}

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <AdminRemoteControl />
    </QueryClientProvider>
  )
  return qc
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.me = { organization: { id: 'org-one' }, is_org_admin: true }
  mocks.fetch.mockResolvedValue(structuredClone(view))
  mocks.confirm.mockResolvedValue(true)
  mocks.save.mockImplementation(async (_version, policy) => ({
    ...view,
    policy,
    version: 'b'.repeat(64),
    revokedSessions: 2,
  }))
  mocks.close.mockResolvedValue({
    ...view,
    policy: { ...view.policy, enabled: false },
    version: 'c'.repeat(64),
    revokedSessions: 2,
  })
})

describe('organization remote-control policy editor', () => {
  it('blocks direct navigation by non-admins before fetching policy', () => {
    mocks.me.is_org_admin = false
    mount()
    expect(screen.getByText('forbidden.description')).toBeInTheDocument()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('saves an empty allowlist as nobody, with the loaded version', async () => {
    mount()
    const selector = await screen.findByLabelText('remoteControl.controllers')
    fireEvent.change(selector, { target: { value: 'selected' } })
    fireEvent.click(screen.getByRole('button', { name: 'remoteControl.save' }))
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(view.version, {
        ...view.policy,
        controllers: [],
      })
    )
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'remoteControl.saveConfirm' })
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'remoteControl.saved'
    )
  })

  it('keeps member account IDs and sends exact numeric policy values', async () => {
    mount()
    fireEvent.change(await screen.findByLabelText('remoteControl.targets'), {
      target: { value: 'selected' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select member' }))
    fireEvent.change(
      screen.getByLabelText('remoteControl.requests_per_minute'),
      { target: { value: '2' } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'remoteControl.save' }))
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(view.version, {
        ...view.policy,
        targets: ['member-one'],
        requests_per_minute: 2,
      })
    )
  })

  it('does not overwrite a conflicting policy and keeps emergency close available', async () => {
    mocks.save.mockRejectedValue(
      new ApiError(409, { code: 'policy_version_conflict' })
    )
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: 'remoteControl.save' })
    )
    expect(
      await screen.findByText('remoteControl.conflict')
    ).toBeInTheDocument()
    expect(mocks.save).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'remoteControl.emergencyClose' })
    )
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1))
    expect(mocks.close).toHaveBeenCalledWith()
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        danger: true,
        message: 'remoteControl.closeConfirm',
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('remoteControl.enabled')).not.toBeChecked()
    )
  })

  it('does not mutate when the administrator cancels confirmation', async () => {
    mocks.confirm.mockResolvedValue(false)
    mount()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'remoteControl.emergencyClose',
      })
    )
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('rejects out-of-range numeric edits before submission', async () => {
    mount()
    fireEvent.change(
      await screen.findByLabelText('remoteControl.max_seconds'),
      { target: { value: '1801' } }
    )
    expect(
      screen.getByRole('button', { name: 'remoteControl.save' })
    ).toBeDisabled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
