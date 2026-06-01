import { Participant, Track } from 'livekit-client'
import Source = Track.Source
import { useRoomData } from '../livekit/hooks/useRoomData'
import {
  useNotifyParticipants,
  NotificationType,
} from '@/features/notifications'
import { fetchApi } from '@/api/fetchApi'

import { useCallback } from 'react'

export const useMuteParticipant = () => {
  const apiRoomData = useRoomData()
  const { notifyParticipants } = useNotifyParticipants()

  const muteParticipant = useCallback(
    async (participant: Participant) => {
      if (!apiRoomData?.livekit?.room) {
        throw new Error('Room id is not available')
      }

      const trackSid = participant.getTrackPublication(
        Source.Microphone
      )?.trackSid

      if (!trackSid) {
        return
      }

      // Always send the LiveKit token. Backend's mute-participant declares
      // `authentication_classes=[LiveKitTokenAuth, *defaults]`, and the
      // admin path of CanMuteParticipant relies on the request user having
      // an OWNER ResourceAccess row — that path is fragile in SSO-fronted
      // deployments where the Django session cookie isn't reliably
      // populated (the frontend keeps the user logged in via a Keycloak
      // Bearer in localStorage, not a Django session). The room-scoped
      // LiveKit token, which every participant already has, satisfies the
      // non-admin CanMuteParticipant branch (everyone_can_mute defaults to
      // true) and works uniformly for owners and non-owners alike.
      if (!apiRoomData.livekit.token) {
        console.error('Cannot mute participant: missing LiveKit token')
        return
      }

      const headers = {
        Authorization: `Bearer ${apiRoomData.livekit.token}`,
      }

      let response
      try {
        response = await fetchApi(
          `rooms/${apiRoomData.livekit.room}/mute-participant/`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              participant_identity: participant.identity,
              track_sid: trackSid,
            }),
          }
        )
      } catch (error) {
        console.error(
          `Failed to mute participant ${participant.identity}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
        return
      }

      try {
        await notifyParticipants({
          type: NotificationType.ParticipantMuted,
          destinationIdentities: [participant.identity],
        })
      } catch (e) {
        console.error(
          `Failed to notify muted participant ${participant.identity}: ${e}`
        )
      }

      return response
    },
    [apiRoomData, notifyParticipants]
  )

  return { muteParticipant }
}
