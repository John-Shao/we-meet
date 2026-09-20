import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SpeakerTimeline } from './SpeakerTimeline'
import type { ApiSpeakerTimeline } from '../api/ApiCaptureSession'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: unknown) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}))
const timeline: ApiSpeakerTimeline = {
  basis: 'recognized_extent',
  status: 'available',
  reason: null,
  extent_ms: 7000,
  intervals: [
    { start_ms: 0, end_ms: 1000 },
    { start_ms: 4000, end_ms: 6000 },
  ],
}
it('preserves silence geometrically and seeks to an exact interval start', () => {
  const seek = vi.fn()
  const { container } = render(
    <SpeakerTimeline timeline={timeline} onSeek={seek} />
  )
  const spans = container.querySelectorAll('rect')
  expect(Number(spans[2].getAttribute('x'))).toBeCloseTo((4000 / 7000) * 1000)
  expect(Number(spans[2].getAttribute('width'))).toBeCloseTo(
    (2000 / 7000) * 1000
  )
  fireEvent.click(screen.getByText('speakerTimeline.intervals:{"count":2}'))
  fireEvent.click(
    screen.getByRole('button', {
      name: 'speakerTimeline.seek:{"start":"0:04","end":"0:06"}',
    })
  )
  expect(seek).toHaveBeenCalledWith(4000)
})
it('keeps time ranges readable without granting playback', () => {
  render(<SpeakerTimeline timeline={timeline} />)
  fireEvent.click(screen.getByText('speakerTimeline.intervals:{"count":2}'))
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByText('0:04 – 0:06')).toBeInTheDocument()
  expect(screen.getByText('speakerTimeline.readOnly')).toBeInTheDocument()
})
it('supports partial timestamps without claiming full media duration', () => {
  render(<SpeakerTimeline timeline={{ ...timeline, status: 'partial' }} />)
  expect(screen.getByText('speakerTimeline.partial')).toBeInTheDocument()
  expect(
    screen.getByText('speakerTimeline.basis:{"end":"0:07"}')
  ).toBeInTheDocument()
})
it.each([
  { ...timeline, status: 'unavailable' as const },
  { ...timeline, extent_ms: 0 },
  { ...timeline, intervals: [{ start_ms: 0, end_ms: 8000 }] },
  {
    ...timeline,
    intervals: [
      { start_ms: 5000, end_ms: 6000 },
      { start_ms: 4000, end_ms: 5000 },
    ],
  },
  { ...timeline, intervals: [] },
])('rejects invalid or unavailable offsets', (value) => {
  render(<SpeakerTimeline timeline={value} onSeek={vi.fn()} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByText('speakerTimeline.unavailable')).toBeInTheDocument()
})
it('omits unsupported timelines on older servers', () => {
  const { container } = render(<SpeakerTimeline />)
  expect(container).toBeEmptyDOMElement()
})
it('pages accessible intervals without losing later offsets', () => {
  const seek = vi.fn()
  render(
    <SpeakerTimeline
      timeline={{
        ...timeline,
        extent_ms: 22000,
        intervals: Array.from({ length: 11 }, (_, index) => ({
          start_ms: index * 2000,
          end_ms: index * 2000 + 1000,
        })),
      }}
      onSeek={seek}
    />
  )
  fireEvent.click(screen.getByText('speakerTimeline.intervals:{"count":11}'))
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  fireEvent.click(
    screen.getByRole('button', {
      name: 'speakerTimeline.seek:{"start":"0:20","end":"0:21"}',
    })
  )
  expect(seek).toHaveBeenCalledWith(20000)
})
