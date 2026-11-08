import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminPage } from './AdminPage'

let role = 'owner'
let providerConfigured = true

const createExportMock = {
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
}

const usageData = {
  from: '2026-10-25',
  to: '2026-11-01',
  note: '服务端固定文案',
  items: [
    {
      provider: 'aliyun',
      model: 'qwen3.8-flash',
      input_tokens: 107,
      output_tokens: 43,
      cached_input_tokens: 10,
      run_count: 3,
    },
  ],
}

// Mutable so one case can render the disabled-query state (pending + idle) that
// the page has to tell apart from an actual first load.
const usageMock: {
  data: typeof usageData | undefined
  isPending: boolean
  isError: boolean
  fetchStatus: string
} = {
  data: usageData,
  isPending: false,
  isError: false,
  fetchStatus: 'fetching',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/queries', () => ({
  useWorkBootstrap: () => ({
    data: { org: { role } },
    isLoading: false,
    isError: false,
  }),
  useAdminOverview: () => ({
    data: {
      org_id: 'org_a',
      name: 'Acme',
      seats: { total: 2, active: 1 },
      quota: {
        limit_tokens: 1000,
        reserved_tokens: 10,
        settled_tokens: 20,
        enforcement: 'soft',
      },
      audit_retention_days: 365,
      quota_period_id: '2026-11',
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAdminSeats: () => ({
    data: {
      pages: [
        {
          items: [
            {
              subject_id: 'sub_a',
              role: 'owner',
              work_seat: true,
              status: 'active',
              revision: 1,
            },
          ],
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useCreateAdminAuditExport: () => createExportMock,
  useAdminAuditExport: () => ({ data: undefined }),
  useDownloadAdminAuditExport: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useAdminProviderConfig: () =>
    providerConfigured
      ? {
          data: {
            config_id: 'cfg-1',
            revision: 2,
            provider: 'aliyun',
            model: 'qwen3.8-flash',
            region: '',
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
          },
          isPending: false,
          isError: false,
          error: null,
        }
      : {
          data: undefined,
          isPending: false,
          isError: true,
          error: { code: 'not_found' },
        },
  // AdminPage now renders the owner write panel, so the page mock has to answer the five
  // mutation hooks it consumes or the owner cases fail on an undefined hook.
  useSetAdminProviderConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeAdminProviderConfig: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCreateAdminProviderCredential: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRotateAdminProviderCredential: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRevokeAdminProviderCredential: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useAdminUsage: () => usageMock,
}))

const stubViewport = (readOnly: boolean) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: readOnly,
    media: '(max-width: 767px)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

afterEach(() => {
  cleanup()
  role = 'owner'
  providerConfigured = true
  usageMock.data = usageData
  usageMock.isPending = false
  usageMock.isError = false
  usageMock.fetchStatus = 'fetching'
  createExportMock.mutateAsync.mockReset()
  vi.unstubAllGlobals()
})

describe('AdminPage', () => {
  it('renders overview and seats for an owner', () => {
    stubViewport(false)
    render(<AdminPage />)
    expect(screen.getByText('admin.title')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('sub_a')).toBeInTheDocument()
    expect(screen.getByText('2026-11')).toBeInTheDocument()
    expect(screen.getByText('admin.createExport')).toBeInTheDocument()
    expect(screen.getByText('admin.providerTitle')).toBeInTheDocument()
    expect(screen.getByText('9b3c03d25b217cc9')).toBeInTheDocument()
    expect(screen.getByText('admin.usageTitle')).toBeInTheDocument()
    // Owners get the editable write panel, where the model lives in a field rather than a
    // second text row, so the usage table is the only text occurrence and the configuration
    // itself is read back through the form control.
    expect(screen.getAllByText('qwen3.8-flash')).toHaveLength(1)
    expect(screen.getByDisplayValue('qwen3.8-flash')).toBeTruthy()
    expect(screen.getByText('107')).toBeInTheDocument()
    // 服务端的固定 note 不直接上屏，文案走本地化 key。
    expect(screen.getByText('admin.usageNote')).toBeInTheDocument()
    expect(screen.queryByText('服务端固定文案')).not.toBeInTheDocument()
  })

  it('shows a not-configured notice instead of an error when the provider read 404s', () => {
    providerConfigured = false
    stubViewport(false)
    render(<AdminPage />)
    expect(screen.getByText('admin.providerEmpty')).toBeInTheDocument()
    expect(screen.queryByText('admin.providerError')).not.toBeInTheDocument()
  })

  it('hides the audit export form on a read-only phone viewport', () => {
    stubViewport(true)
    render(<AdminPage />)
    expect(screen.getByText('admin.exportTitle')).toBeInTheDocument()
    expect(screen.getByText('admin.exportMobileNotice')).toBeInTheDocument()
    expect(screen.queryByText('admin.createExport')).not.toBeInTheDocument()
    expect(screen.getByText('sub_a')).toBeInTheDocument()
  })

  it('does not render the admin surface for a member', () => {
    stubViewport(false)
    role = 'member'
    render(<AdminPage />)
    expect(screen.getByText('admin.forbiddenTitle')).toBeInTheDocument()
    expect(screen.queryByText('admin.title')).not.toBeInTheDocument()
  })

  // L5: the create-export handler awaits a mutation, so a cleared or reversed
  // range must be refused before anything is sent - and say why.
  it('refuses an export with a cleared date range', () => {
    stubViewport(false)
    render(<AdminPage />)
    fireEvent.change(screen.getByLabelText('admin.from'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'admin.createExport' }))
    expect(screen.getByText('admin.exportRangeRequired')).toBeInTheDocument()
    expect(createExportMock.mutateAsync).not.toHaveBeenCalled()
  })

  it('refuses an export whose start date is after its end date', () => {
    stubViewport(false)
    render(<AdminPage />)
    fireEvent.change(screen.getByLabelText('admin.from'), {
      target: { value: '2026-11-10' },
    })
    fireEvent.change(screen.getByLabelText('admin.to'), {
      target: { value: '2026-11-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'admin.createExport' }))
    expect(
      screen.getByText('errors.auditExportRangeInvalid')
    ).toBeInTheDocument()
    expect(createExportMock.mutateAsync).not.toHaveBeenCalled()
  })

  // U3: a disabled usage query is pending with fetchStatus 'idle' forever; that
  // is "choose a range", not a spinner.
  it('asks for a range instead of loading forever when the usage query is disabled', () => {
    usageMock.data = undefined
    usageMock.isPending = true
    usageMock.fetchStatus = 'idle'
    stubViewport(false)
    render(<AdminPage />)
    expect(screen.getByText('admin.usagePickRange')).toBeInTheDocument()
    expect(screen.queryByText('loading')).not.toBeInTheDocument()
  })
})
