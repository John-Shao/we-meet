import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Home } from './Home'

const auth = vi.hoisted(() => ({ loggedIn: false }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({
    isLoggedIn: auth.loggedIn,
    user: auth.loggedIn ? { id: 'owner' } : undefined,
  }),
  UserAware: ({ children }: { children: ReactNode }) => <>{children}</>,
  authUrl: () => '/login',
}))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({ data: { meeting_records: { enabled: true } } }),
}))
vi.mock('@/features/rooms', () => ({
  useCreateRoom: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/features/rooms/livekit/hooks/usePersistentUserChoices', () => ({
  usePersistentUserChoices: () => ({ userChoices: { username: '' } }),
}))
vi.mock('@/features/calendar', () => ({
  EventDetailHost: () => null,
  CreateEventDialog: () => null,
}))
vi.mock('@/features/meetings', () => ({
  MeetingDetailPanel: () => null,
  MeetingNavPanel: () => null,
  ScheduledMeetingsList: () => <h2>Scheduled meetings</h2>,
  RecentMeetingsList: () => <h2>Recent meetings</h2>,
}))
vi.mock('@/navigation/navigateTo', () => ({ navigateTo: vi.fn() }))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../components/JoinMeetingDialog', () => ({
  JoinMeetingDialog: () => null,
}))
vi.mock('../components/IntroSlider', () => ({ IntroSlider: () => null }))
vi.mock('../components/MoreLink', () => ({ MoreLink: () => null }))

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
afterEach(() => {
  client.clear()
  auth.loggedIn = false
})

it('retains scheduled and historical sections only in the signed-in workspace', () => {
  auth.loggedIn = true
  const view = () => (
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>
  )
  const { rerender } = render(view())
  expect(
    screen.getByRole('heading', { name: 'Scheduled meetings' })
  ).toBeInTheDocument()
  expect(
    screen.getByRole('heading', { name: 'Recent meetings' })
  ).toBeInTheDocument()
  auth.loggedIn = false
  rerender(view())
  expect(
    screen.queryByRole('heading', { name: 'Recent meetings' })
  ).not.toBeInTheDocument()
  // 未登录落地页两个列表都不挂:它以前在落地页上也放了一份「预约会议」,但传的是
  // `enabled={!!isLoggedIn}` —— 而落地页这一支本身就只在未登录时渲染,那份列表
  // 永远 `return null`(死代码,已删)。落地页只留 [登录] + [加入会议]。
  expect(
    screen.queryByRole('heading', { name: 'Scheduled meetings' })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'login' })).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'createMeeting' })
  ).not.toBeInTheDocument()
})
