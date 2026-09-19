import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SpeakerActivity } from './SpeakerActivity'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: unknown) =>
      values ? JSON.stringify(values) : key,
  }),
}))

it('labels recognized speaker time and exposes a bounded accessible meter', () => {
  render(
    <SpeakerActivity
      activity={{
        basis: 'recognized_speaker_time',
        status: 'partial',
        duration_ms: 65000,
        share_percent: 42.5,
      }}
    />
  )
  expect(screen.getByText('{"time":"1:05","percent":42.5}')).toBeInTheDocument()
  expect(screen.getByRole('meter')).toHaveAttribute('value', '42.5')
  expect(screen.getByText('speakerActivity.partial')).toBeInTheDocument()
})

it.each([
  undefined,
  {
    basis: 'recognized_speaker_time' as const,
    status: 'unavailable' as const,
    duration_ms: null,
    share_percent: null,
  },
  {
    basis: 'recognized_speaker_time' as const,
    status: 'available' as const,
    duration_ms: 100,
    share_percent: 101,
  },
])(
  'does not fabricate a percentage for missing or invalid data',
  (activity) => {
    render(<SpeakerActivity activity={activity} />)
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect(screen.getByText('speakerActivity.unavailable')).toBeInTheDocument()
  }
)
