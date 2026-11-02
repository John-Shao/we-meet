import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminProviderPanel } from './AdminProviderPanel'

// The panel is the only place the D-08d admin write face becomes reachable, so these assertions
// are about the calls it makes and the two rules the API imposes on the UI: an api_key is
// write-only and must not survive the submit, and the id returned by a create is what the next
// save has to reference.
const baseConfig = {
  config_id: 'cfg-1',
  revision: 2,
  provider: 'aliyun',
  model: 'qwen3.8-flash',
  region: 'cn-beijing',
  endpoint: 'https://dashscope.example/v1',
  credential_mode: 'managed_key',
  credential: {
    credential_id: 'cred-1',
    provider: 'aliyun',
    mode: 'managed_key',
    fingerprint: '9b3c03d25b217cc9',
    key_version: 2,
    state: 'active',
    created_at: '2026-10-31T00:00:00Z',
  },
  state: 'active',
  created_at: '2026-10-31T00:00:00Z',
}

let config: unknown = baseConfig

const setConfig = vi.fn()
const revokeConfig = vi.fn()
const createCredential = vi.fn()
const rotateCredential = vi.fn()
const revokeCredential = vi.fn()

const mutation = (fn: ReturnType<typeof vi.fn>) => ({
  mutateAsync: fn,
  isPending: false,
})

vi.mock('react-i18next', () => ({
  // Keys stand in for text: asserting on the key is what keeps these cases independent of the
  // five locale files, which are checked separately by the locale key gate.
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/queries', () => ({
  useAdminProviderConfig: () => ({
    data: config,
    isPending: false,
    isError: false,
    error: null,
  }),
  useSetAdminProviderConfig: () => mutation(setConfig),
  useRevokeAdminProviderConfig: () => mutation(revokeConfig),
  useCreateAdminProviderCredential: () => mutation(createCredential),
  useRotateAdminProviderCredential: () => mutation(rotateCredential),
  useRevokeAdminProviderCredential: () => mutation(revokeCredential),
}))

const keyInput = () =>
  document.querySelector('input[type="password"]') as HTMLInputElement
const reasonInput = () =>
  screen.getByLabelText('admin.reason') as HTMLInputElement

describe('AdminProviderPanel', () => {
  beforeEach(() => {
    config = baseConfig
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('starts from the configuration in effect rather than from blanks', () => {
    render(<AdminProviderPanel />)
    expect(screen.getByDisplayValue('qwen3.8-flash')).toBeTruthy()
    expect(
      screen.getByDisplayValue('https://dashscope.example/v1')
    ).toBeTruthy()
    expect(screen.getByDisplayValue('cred-1')).toBeTruthy()
    expect(screen.getByText('9b3c03d25b217cc9')).toBeTruthy()
  })

  it('saves with the revision the form was built from', async () => {
    setConfig.mockResolvedValue({ ...baseConfig, revision: 3 })
    render(<AdminProviderPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'admin.providerSave' }))
    await vi.waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({
        provider: 'aliyun',
        model: 'qwen3.8-flash',
        region: 'cn-beijing',
        endpoint: 'https://dashscope.example/v1',
        credential_mode: 'managed_key',
        credential_id: 'cred-1',
        expected_revision: 2,
      })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('admin.providerSaved')).toBeTruthy()
    )
  })

  it('reports a stale revision as someone else changing it', async () => {
    setConfig.mockRejectedValue({ code: 'version_conflict', status: 409 })
    render(<AdminProviderPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'admin.providerSave' }))
    await vi.waitFor(() =>
      expect(screen.getByText('admin.providerConflict')).toBeTruthy()
    )
    expect(setConfig).toHaveBeenCalledTimes(1)
  })

  it('will not save an endpoint that is not https', () => {
    // react-aria does not expose the guard as a DOM attribute at all, so the guard is asserted
    // where it matters: an invalid form must not reach the API.
    config = { ...baseConfig, endpoint: 'http://dashscope.example/v1' }
    render(<AdminProviderPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'admin.providerSave' }))
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('needs a full length key before it will create a managed credential, then adopts the id', async () => {
    render(<AdminProviderPanel />)
    const create = screen.getByRole('button', {
      name: 'admin.credentialCreate',
    })
    fireEvent.change(keyInput(), { target: { value: 'short' } })
    fireEvent.click(create)
    expect(createCredential).not.toHaveBeenCalled()

    fireEvent.change(keyInput(), { target: { value: 'a-long-enough-key' } })
    createCredential.mockResolvedValue({
      credential_id: 'cred-9',
      provider: 'aliyun',
      mode: 'managed_key',
      fingerprint: 'deadbeefcafef00d',
      key_version: 1,
      state: 'active',
      created_at: '2026-11-02T00:00:00Z',
    })
    fireEvent.click(create)
    await vi.waitFor(() =>
      expect(createCredential).toHaveBeenCalledWith({
        provider: 'aliyun',
        mode: 'managed_key',
        api_key: 'a-long-enough-key',
      })
    )
    await vi.waitFor(() => {
      // Both sides of the write-only rule land in the same render: the new id is adopted for the
      // next save, and the key field is empty again because nothing may echo it back.
      expect(screen.getByDisplayValue('cred-9')).toBeTruthy()
      expect(keyInput().value).toBe('')
    })
  })

  it('revokes the selected credential only once a reason is given', async () => {
    revokeCredential.mockResolvedValue({
      credential_id: 'cred-1',
      state: 'revoked',
    })
    render(<AdminProviderPanel />)
    const revoke = screen.getByRole('button', {
      name: 'admin.credentialRevoke',
    })
    fireEvent.click(revoke)
    expect(revokeCredential).not.toHaveBeenCalled()

    fireEvent.change(reasonInput(), { target: { value: 'key_leaked' } })
    fireEvent.click(revoke)
    await vi.waitFor(() =>
      expect(revokeCredential).toHaveBeenCalledWith({
        credentialId: 'cred-1',
        body: { reason: 'key_leaked' },
      })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('admin.credentialRevoked')).toBeTruthy()
    )
  })

  it('revokes the organization configuration with the reason it was given', async () => {
    revokeConfig.mockResolvedValue({ org_id: 'org_a', state: 'revoked' })
    render(<AdminProviderPanel />)
    fireEvent.change(reasonInput(), { target: { value: 'vendor_switch' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'admin.providerRevoke' })
    )
    await vi.waitFor(() =>
      expect(revokeConfig).toHaveBeenCalledWith({ reason: 'vendor_switch' })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('admin.providerRevoked')).toBeTruthy()
    )
  })
})
