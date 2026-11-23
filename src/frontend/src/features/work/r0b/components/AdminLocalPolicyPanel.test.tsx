import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkApiError } from '../../r0a/api/client'
import { AdminLocalPolicyPanel } from './AdminLocalPolicyPanel'

const state = vi.hoisted(() => ({
  phases: ['R0a', 'R0b'] as string[],
  reads: 0,
  readOnly: false,
  policy: undefined as unknown,
  refetch: vi.fn(),
  save: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../r0a/api/queries', () => ({
  useWorkBootstrap: () => ({ data: { phases: state.phases } }),
}))
vi.mock('../../r0a/hooks/useReadOnlyViewport', () => ({
  useReadOnlyViewport: () => state.readOnly,
}))
vi.mock('../api/queries', () => ({
  useWorkLocalPolicy: () => {
    state.reads += 1
    return {
      data: state.policy,
      isPending: false,
      isError: false,
      refetch: state.refetch,
    }
  },
  useSetWorkLocalPolicy: () => ({
    mutateAsync: state.save,
    isPending: false,
  }),
}))

const configured = {
  org_id: 'org-1',
  configured: true as const,
  gate: 'ready' as const,
  allowed_tools: ['workspace.read'],
  allowed_destinations: ['device_local'],
  classification_rules: [
    {
      classification: 'local_only',
      max_confirmable: 'local_only',
      matcher: { path_prefix: '/docs' },
    },
  ],
  classification_default: 'local_only' as const,
  classification_default_confirmed: true,
  classification_floor: 'local_only' as const,
  readonly_max_actions: 5,
  readonly_ttl: '01:00:00',
  input_limit_bytes: 1024,
  output_limit_bytes: 2048,
  effective_epoch: 3,
  revision: 4,
}

const saveButton = () =>
  screen.getByRole('button', { name: 'admin.localPolicy.save' })

beforeEach(() => {
  state.phases = ['R0a', 'R0b']
  state.reads = 0
  state.readOnly = false
  state.policy = configured
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('AdminLocalPolicyPanel', () => {
  it('does not read the v2 admin face when the org lacks the R0b phase', () => {
    state.phases = ['R0a']
    const { container } = render(<AdminLocalPolicyPanel />)
    expect(state.reads).toBe(0)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the server verdict and prefills the document in effect', () => {
    render(<AdminLocalPolicyPanel />)
    expect(state.reads).toBe(1)
    expect(screen.getByText(/admin\.localPolicy\.gate\.ready/)).toBeTruthy()
    expect(
      (screen.getByLabelText('workspace.read') as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (screen.getByLabelText('workspace.list') as HTMLInputElement).checked
    ).toBe(false)
    expect(
      (screen.getByLabelText('device_local') as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (
        screen.getByLabelText(
          'admin.localPolicy.maxActions'
        ) as HTMLInputElement
      ).value
    ).toBe('5')
    expect(
      (screen.getByLabelText('admin.localPolicy.ttl') as HTMLInputElement).value
    ).toBe('01:00:00')
    // The confirmation is one-way in SQL, so the stored true value locks the control.
    expect(
      (screen.getByLabelText('admin.localPolicy.confirmed') as HTMLInputElement)
        .disabled
    ).toBe(true)
    expect(
      (screen.getByLabelText('admin.localPolicy.rules') as HTMLTextAreaElement)
        .value
    ).toContain('"path_prefix": "/docs"')
  })

  it('saves the whole document against the revision the form was built from', async () => {
    state.save.mockResolvedValue({ ...configured, revision: 5 })
    render(<AdminLocalPolicyPanel />)
    fireEvent.click(saveButton())
    await vi.waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({
        revision: 4,
        client_request_id: expect.any(String),
        allowed_tools: ['workspace.read'],
        allowed_destinations: ['device_local'],
        classification_rules: configured.classification_rules,
        classification_default: 'local_only',
        classification_default_confirmed: true,
        classification_floor: 'local_only',
        readonly_max_actions: 5,
        readonly_ttl: '01:00:00',
        input_limit_bytes: 1024,
        output_limit_bytes: 2048,
      })
    )
    await vi.waitFor(() =>
      expect(screen.getByText('admin.localPolicy.saved')).toBeTruthy()
    )
  })

  it('reports a stale revision as another administrator and re-reads instead of retrying', async () => {
    state.save.mockRejectedValue(
      new WorkApiError(409, {
        code: 'governance_revision_conflict',
        current_revision: 7,
      })
    )
    render(<AdminLocalPolicyPanel />)
    fireEvent.click(saveButton())
    await vi.waitFor(() =>
      expect(screen.getByText('admin.localPolicy.conflict')).toBeTruthy()
    )
    expect(state.save).toHaveBeenCalledTimes(1)
    expect(state.refetch).toHaveBeenCalled()
  })

  it('refuses rules that are not a JSON array before reaching the API', () => {
    render(<AdminLocalPolicyPanel />)
    fireEvent.change(screen.getByLabelText('admin.localPolicy.rules'), {
      target: { value: '{not json' },
    })
    fireEvent.click(saveButton())
    expect(screen.getByText('admin.localPolicy.rulesInvalid')).toBeTruthy()
    expect(state.save).not.toHaveBeenCalled()
  })

  it('creates revision 1 from an unconfigured organization', async () => {
    state.policy = {
      org_id: 'org-1',
      configured: false,
      gate: 'local_policy_not_configured',
    }
    state.save.mockResolvedValue({ ...configured, revision: 1 })
    render(<AdminLocalPolicyPanel />)
    expect(screen.getByText('admin.localPolicy.notConfigured')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('admin.localPolicy.maxActions'), {
      target: { value: '3' },
    })
    fireEvent.change(screen.getByLabelText('admin.localPolicy.ttl'), {
      target: { value: '00:05:00' },
    })
    fireEvent.change(screen.getByLabelText('admin.localPolicy.inputLimit'), {
      target: { value: '512' },
    })
    fireEvent.change(screen.getByLabelText('admin.localPolicy.outputLimit'), {
      target: { value: '512' },
    })
    fireEvent.click(saveButton())
    await vi.waitFor(() =>
      expect(state.save).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: 0,
          allowed_tools: [],
          allowed_destinations: [],
          classification_rules: [],
          classification_default_confirmed: false,
        })
      )
    )
  })

  it('requires an explicit action limit before the first write', () => {
    state.policy = {
      org_id: 'org-1',
      configured: false,
      gate: 'local_policy_not_configured',
    }
    render(<AdminLocalPolicyPanel />)
    fireEvent.change(screen.getByLabelText('admin.localPolicy.ttl'), {
      target: { value: '00:05:00' },
    })
    fireEvent.change(screen.getByLabelText('admin.localPolicy.inputLimit'), {
      target: { value: '512' },
    })
    fireEvent.change(screen.getByLabelText('admin.localPolicy.outputLimit'), {
      target: { value: '512' },
    })
    fireEvent.click(saveButton())
    expect(screen.getByText('admin.localPolicy.numbersRequired')).toBeTruthy()
    expect(state.save).not.toHaveBeenCalled()
  })

  it('keeps the form read-only below the desktop breakpoint', () => {
    state.readOnly = true
    render(<AdminLocalPolicyPanel />)
    expect(
      screen.queryByRole('button', { name: 'admin.localPolicy.save' })
    ).toBeNull()
    expect(screen.getByText('admin.localPolicy.mobileNotice')).toBeTruthy()
  })
})
