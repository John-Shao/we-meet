import { render, screen } from '@testing-library/react'
import { Track } from 'livekit-client'
import { describe, expect, it, vi } from 'vitest'
import { MeetingRoomAudioRenderer } from './MeetingRoomAudioRenderer'

const mocks = vi.hoisted(() => ({ allowed: false, privateAllowed: false }))
vi.mock('../translationContext', () => ({
  usePrivateTranslation: () => ({ canPlay: () => mocks.privateAllowed }),
}))
vi.mock('../interpretationContext', () => ({
  useInterpretation: () => ({ canPlay: () => mocks.allowed }),
}))
vi.mock('@livekit/components-react', () => ({
  useTracks: () =>
    ['human', 'translation-private', 'interpretation-shared'].map(
      (identity) => ({
        participant: { identity, isLocal: false },
        publication: { kind: Track.Kind.Audio, trackSid: identity },
        source: Track.Source.Unknown,
      })
    ),
  AudioTrack: ({
    trackRef,
  }: {
    trackRef: { participant: { identity: string } }
  }) => <span data-testid={trackRef.participant.identity} />,
}))
describe('Meeting audio rendering', () => {
  it('preserves ordinary audio while never mounting unauthorized interpretation', () => {
    mocks.allowed = false
    mocks.privateAllowed = false
    const view = render(<MeetingRoomAudioRenderer />)
    expect(screen.getByTestId('human')).toBeInTheDocument()
    expect(screen.queryByTestId('translation-private')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('interpretation-shared')
    ).not.toBeInTheDocument()
    mocks.privateAllowed = true
    view.rerender(<MeetingRoomAudioRenderer />)
    expect(screen.getByTestId('translation-private')).toBeInTheDocument()
    mocks.privateAllowed = false
    view.rerender(<MeetingRoomAudioRenderer />)
    expect(screen.queryByTestId('translation-private')).not.toBeInTheDocument()
    mocks.allowed = true
    view.rerender(<MeetingRoomAudioRenderer />)
    expect(screen.getByTestId('interpretation-shared')).toBeInTheDocument()
    mocks.allowed = false
    view.rerender(<MeetingRoomAudioRenderer />)
    expect(
      screen.queryByTestId('interpretation-shared')
    ).not.toBeInTheDocument()
  })
})
