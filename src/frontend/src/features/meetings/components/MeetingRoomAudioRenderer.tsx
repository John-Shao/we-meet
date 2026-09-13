import { AudioTrack, useTracks } from '@livekit/components-react'
import { getTrackReferenceId } from '@livekit/components-core'
import { Track, type RemoteParticipant } from 'livekit-client'
import { useInterpretation } from '../interpretationContext'
import { isInterpretationAgent } from '../interpretationEvents'
import { usePrivateTranslation } from '../translationContext'
import { isTranslationAgent } from '../translationEvents'

/** Interpretation tracks only mount after a current, explicitly selected grant. */
export function MeetingRoomAudioRenderer() {
  const interpretation = useInterpretation()
  const translation = usePrivateTranslation()
  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: true,
    }
  ).filter(
    (ref) =>
      !ref.participant.isLocal && ref.publication.kind === Track.Kind.Audio
  )
  return (
    <div style={{ display: 'none' }}>
      {tracks
        .filter(
          (ref) =>
            !isTranslationAgent(ref.participant.identity) ||
            translation?.canPlay(
              ref.participant as RemoteParticipant,
              ref.publication.trackSid
            )
        )
        .filter(
          (ref) =>
            !isInterpretationAgent(ref.participant.identity) ||
            interpretation?.canPlay(
              ref.participant as RemoteParticipant,
              ref.publication.trackSid
            )
        )
        .map((trackRef) => (
          <AudioTrack key={getTrackReferenceId(trackRef)} trackRef={trackRef} />
        ))}
    </div>
  )
}
