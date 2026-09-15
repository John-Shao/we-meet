import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MeetingNavPanel } from './MeetingNavPanel'
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
      ['title', 'audioRecording'],
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

  it('keeps video navigation selected on the join page', () => {
    state.path = '/meeting/join'
    render(<MeetingNavPanel />)
    expect(
      screen.getByRole('button', { name: 'library.video' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('selects records for a record deep link', () => {
    state.path = '/meeting/records/record-id'
    render(<MeetingNavPanel />)
    expect(
      screen.getByRole('button', { name: 'library.notes' })
    ).toHaveAttribute('aria-current', 'page')
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
      screen.queryByRole('button', { name: 'title' })
    ).not.toBeInTheDocument()
  })
})
