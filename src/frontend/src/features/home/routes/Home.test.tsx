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
  ScheduledMeetingsList: () => null,
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

it('keeps after-meeting links in the signed-in workspace and removes them on logout', () => {
  auth.loggedIn = true
  const view = () => (
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>
  )
  const { rerender } = render(view())
  expect(screen.getByRole('link', { name: 'library.notes' })).toHaveAttribute(
    'href',
    '/meeting/notes'
  )
  expect(screen.getByRole('link', { name: 'library.minutes' })).toHaveAttribute(
    'href',
    '/meeting/minutes'
  )

  auth.loggedIn = false
  rerender(view())
  expect(screen.getByRole('button', { name: 'login' })).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'joinMeeting' })
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('heading', { name: 'materials.title' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'library.notes' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'library.minutes' })
  ).not.toBeInTheDocument()
})
