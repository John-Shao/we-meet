import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InviteRoute } from './InviteRoute'

const inviteApi = vi.hoisted(() => ({
  applyToInvite: vi.fn(),
  cancelJoinRequest: vi.fn(),
  fetchInviteInfo: vi.fn(),
  fetchMyJoinRequests: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('wouter', () => ({
  useRoute: () => [true, { code: 'VRECYTJ9' }],
}))

vi.mock('@/features/auth', () => ({
  useUser: () => ({ isLoggedIn: true }),
}))

vi.mock('./api/invite', () => inviteApi)

const renderRoute = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <InviteRoute />
    </QueryClientProvider>
  )
}

describe('InviteRoute rejection state', () => {
  it('shows the rejection reason and allows another application', async () => {
    inviteApi.fetchInviteInfo.mockResolvedValue({
      valid: true,
      organization_name: 'Default Organization',
      department_name: '开发部',
      require_approval: true,
    })
    inviteApi.fetchMyJoinRequests.mockResolvedValue([
      {
        id: 'request-1',
        organization_name: 'Default Organization',
        department_name: '开发部',
        org_role: 'member',
        status: 'rejected',
        reject_reason: '请使用深圳手机号注册账号',
        created_at: '2026-08-14T08:00:00Z',
        reviewed_at: '2026-08-14T08:05:00Z',
      },
      {
        id: 'request-older',
        organization_name: 'Default Organization',
        department_name: '开发部',
        org_role: 'member',
        status: 'approved',
        reject_reason: '',
        created_at: '2026-08-13T08:00:00Z',
        reviewed_at: '2026-08-13T08:05:00Z',
      },
    ])

    renderRoute()

    expect(await screen.findByText('rejectedBody')).toBeInTheDocument()
    expect(screen.getByText('rejectionReason')).toBeInTheDocument()
    expect(screen.getByText('请使用深圳手机号注册账号')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'reapply' })).toBeInTheDocument()
    expect(inviteApi.fetchMyJoinRequests).toHaveBeenCalledWith('VRECYTJ9')
  })
})
