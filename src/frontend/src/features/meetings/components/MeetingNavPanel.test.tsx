import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MeetingNavPanel } from './MeetingNavPanel'
import { SubNavExpandButton } from '@/components/SubNav'
import { useModuleSubNav } from '@/components/subNavModules'
import { navigateTo } from '@/navigation/navigateTo'

const state = vi.hoisted(() => ({ path: '/meeting', enabled: true }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('wouter', () => ({ useLocation: () => [state.path] }))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({
    data: {
      meeting_records: {
        enabled: state.enabled,
        capture_audio_enabled: state.enabled,
      },
    },
  }),
}))
vi.mock('@/navigation/navigateTo', () => ({ navigateTo: vi.fn() }))
vi.mock('@/stores/systemSettings', () => ({ openSystemSettings: vi.fn() }))
vi.mock('@/components/ResizablePanel', () => ({
  ResizablePanel: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe('meeting module navigation', () => {
  beforeEach(() => {
    state.path = '/meeting'
    state.enabled = true
    vi.clearAllMocks()
  })

  it('routes four sections without starting a meeting from navigation', () => {
    render(<MeetingNavPanel />)
    const entries = [
      ['library.video', 'home'],
      ['library.record', 'audioRecording'],
      ['library.notes', 'meetingNotes'],
      ['library.minutes', 'meetingMinutes'],
    ]
    for (const [label, route] of entries) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(navigateTo).toHaveBeenLastCalledWith(route)
    }
    expect(screen.queryByText('quickMeeting')).not.toBeInTheDocument()
    expect(screen.queryByText('joinMeeting')).not.toBeInTheDocument()
  })

  it('selects records for a record deep link', () => {
    state.path = '/meeting/records/record-id'
    render(<MeetingNavPanel />)
    expect(
      screen.getByRole('button', { name: 'library.notes' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it.each([
    '/meeting/recording/capture',
    '/meeting/recording/history/record-1',
  ])('keeps AI recording selected at %s', (path) => {
    state.path = path
    render(<MeetingNavPanel />)
    expect(
      screen.getByRole('button', { name: 'library.record' })
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('button', { name: 'library.video' })
    ).not.toHaveAttribute('aria-current')
  })

  it('retains feature gates for unavailable AI sections', () => {
    state.enabled = false
    render(<MeetingNavPanel />)
    expect(
      screen.getByRole('button', { name: 'library.video' })
    ).toBeInTheDocument()
    expect(screen.queryByText('library.notes')).not.toBeInTheDocument()
    expect(screen.queryByText('library.minutes')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'library.record' })
    ).not.toBeInTheDocument()
  })

  it('collapses the whole column, remembers it, and the content header can expand it', () => {
    localStorage.removeItem('we-meet:meeting-nav-collapsed')
    const view = render(
      <>
        <MeetingNavPanel />
        <ExpandProbe />
      </>
    )
    fireEvent.click(screen.getByTestId('meeting-nav-collapse'))
    // 收起后整栏让出去(不再有 36px 窄条):导航入口都不在,展开按钮在内容页标题栏里
    // —— 由 ExpandProbe 代替真实的内容页标题栏,顺带验证两处用的是同一份状态。
    expect(screen.getByTestId('meeting-nav-expand')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'library.video' })
    ).not.toBeInTheDocument()
    expect(localStorage.getItem('we-meet:meeting-nav-collapsed')).toBe('1')
    // 展开后恢复四节入口,并把收起态清掉。
    fireEvent.click(screen.getByTestId('meeting-nav-expand'))
    expect(
      screen.getByRole('button', { name: 'library.video' })
    ).toBeInTheDocument()
    expect(localStorage.getItem('we-meet:meeting-nav-collapsed')).toBe('0')
    // 收起态写进 localStorage:重新挂载(换页/重开)仍是收起的。
    fireEvent.click(screen.getByTestId('meeting-nav-collapse'))
    expect(localStorage.getItem('we-meet:meeting-nav-collapsed')).toBe('1')
    view.unmount()
    render(
      <>
        <MeetingNavPanel />
        <ExpandProbe />
      </>
    )
    expect(screen.getByTestId('meeting-nav-expand')).toBeInTheDocument()
    localStorage.removeItem('we-meet:meeting-nav-collapsed')
  })
})

/** 内容页标题栏里那颗展开按钮的替身:与面板共享同一份收起态。 */
const ExpandProbe = () => {
  const { collapsed, toggle } = useModuleSubNav('meetings')
  if (!collapsed) return null
  return <SubNavExpandButton onExpand={toggle} testId="meeting-nav-expand" />
}
