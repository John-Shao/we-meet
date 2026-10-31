import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminPage } from './AdminPage'

let role = 'owner'

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
  useCreateAdminAuditExport: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useAdminAuditExport: () => ({ data: undefined }),
  useDownloadAdminAuditExport: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

afterEach(() => {
  cleanup()
  role = 'owner'
})

describe('AdminPage', () => {
  it('renders overview and seats for an owner', () => {
    render(<AdminPage />)
    expect(screen.getByText('admin.title')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('sub_a')).toBeInTheDocument()
    expect(screen.getByText('admin.createExport')).toBeInTheDocument()
  })

  it('does not render the admin surface for a member', () => {
    role = 'member'
    render(<AdminPage />)
    expect(screen.getByText('admin.forbiddenTitle')).toBeInTheDocument()
    expect(screen.queryByText('admin.title')).not.toBeInTheDocument()
  })
})
