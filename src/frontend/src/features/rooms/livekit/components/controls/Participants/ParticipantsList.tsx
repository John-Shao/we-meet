import { useState } from 'react'
import { css } from '@/styled-system/css'
import { useParticipants } from '@livekit/components-react'
import { useQuery } from '@tanstack/react-query'
import { RiUserAddLine } from '@remixicon/react'

import { Div, H } from '@/primitives'
import { useTranslation } from 'react-i18next'
import { useUser } from '@/features/auth'
import { useRoomData } from '../../../hooks/useRoomData'
import { resolveRoomUsers } from '@/features/im/api/resolveRoomUsers'
import { MeetInvitePicker } from '@/features/im/call/MeetInvitePicker'
import { sendMeetInvites } from '@/features/im/call/meetInviteTracker'
import { ParticipantListItem } from '../../controls/Participants/ParticipantListItem'
import { ParticipantsCollapsableList } from '../../controls/Participants/ParticipantsCollapsableList'
import { HandRaisedListItem } from '../../controls/Participants/HandRaisedListItem'
import { LowerAllHandsButton } from '../../controls/Participants/LowerAllHandsButton'
import { WaitingParticipantListItem } from './WaitingParticipantListItem'
import { useWaitingParticipants } from '@/features/rooms/hooks/useWaitingParticipants'
import { Participant } from 'livekit-client'
import { WaitingParticipant } from '@/features/rooms/api/listWaitingParticipants'
import { MuteEveryoneButton } from './MuteEveryoneButton'

// TODO: Optimize rendering performance, especially for longer participant lists, even though they are generally short.
export const ParticipantsList = () => {
  const { t } = useTranslation('rooms', { keyPrefix: 'participants' })

  // Preferred using the 'useParticipants' hook rather than the separate remote and local hooks,
  // because the 'useLocalParticipant' hook does not update the participant's information when their
  // metadata/name changes. The LiveKit team has marked this as a TODO item in the code.
  const participants = useParticipants()

  const sortedRemoteParticipants = participants
    .slice(1)
    .sort((participantA, participantB) => {
      const nameA = participantA.name || participantA.identity
      const nameB = participantB.name || participantB.identity
      return nameA.localeCompare(nameB)
    })

  const sortedParticipants = [
    participants[0], // first participant returned by the hook, is always the local one
    ...sortedRemoteParticipants,
  ]

  const raisedHandParticipants = participants
    .filter((participant) => !!participant.attributes.handRaisedAt)
    .sort((a, b) => {
      const dateA = new Date(a.attributes.handRaisedAt)
      const dateB = new Date(b.attributes.handRaisedAt)
      const timeA = isNaN(dateA.getTime()) ? 0 : dateA.getTime()
      const timeB = isNaN(dateB.getTime()) ? 0 : dateB.getTime()
      return timeA - timeB
    })

  const { waitingParticipants, handleParticipantEntry } =
    useWaitingParticipants()

  // P4.1 会议拉人: ring org members into THIS room (kind=meet invites).
  // Members already present are hidden from the picker via resolve-subs ids;
  // an invited-anyway busy/in-call member auto-answers busy (P4 semantics).
  const { t: tIm } = useTranslation('im')
  const { user } = useUser()
  const roomData = useRoomData()
  const [inviteOpen, setInviteOpen] = useState(false)
  const identities = participants.map((p) => p.identity).sort()
  const { data: roomUsers } = useQuery({
    queryKey: ['rooms', 'resolve-subs', identities],
    queryFn: () => resolveRoomUsers(identities),
    enabled: identities.length > 0,
    staleTime: 300_000,
  })
  const excludeUserIds = new Set(
    Object.values(roomUsers ?? {}).map((e) => e.id)
  )
  const roomSlug = roomData?.slug

  // TODO - extract inline styling in a centralized styling file, and avoid magic numbers
  return (
    <Div overflowY="scroll">
      <H
        lvl={2}
        className={css({
          fontSize: '0.875rem',
          fontWeight: 'bold',
          color: 'greyscale.600',
          padding: '0 1.5rem',
          marginBottom: '0.83em',
        })}
      >
        {t('subheading').toUpperCase()}
      </H>
      {roomSlug && (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          data-testid="participants-invite-members"
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            margin: '0 1.5rem 0.75rem',
            padding: '0.375rem 0.75rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            background: 'transparent',
            color: 'greyscale.700',
            fontSize: '0.8125rem',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          <RiUserAddLine size={16} />
          {tIm('call.stage.addMember')}
        </button>
      )}
      {inviteOpen && roomSlug && (
        <MeetInvitePicker
          excludeUserIds={excludeUserIds}
          onClose={() => setInviteOpen(false)}
          onInvite={(targets) =>
            sendMeetInvites(targets, {
              media: 'video',
              roomSlug,
              roomName: tIm('call.meetInviteRoomName', {
                name: user?.full_name ?? '',
              }),
            })
          }
        />
      )}
      {waitingParticipants?.length > 0 && (
        <Div marginBottom=".9375rem">
          <ParticipantsCollapsableList<WaitingParticipant>
            heading={t('waiting.title')}
            participants={waitingParticipants}
            renderParticipant={(participant) => (
              <WaitingParticipantListItem
                key={participant.id}
                participant={participant}
                onAction={handleParticipantEntry}
              />
            )}
            action={<></>}
          />
        </Div>
      )}
      {raisedHandParticipants.length > 0 && (
        <Div marginBottom=".9375rem">
          <ParticipantsCollapsableList<Participant>
            heading={t('raisedHands')}
            participants={raisedHandParticipants}
            renderParticipant={(participant) => (
              <HandRaisedListItem
                key={participant.identity}
                participant={participant}
              />
            )}
            action={
              <LowerAllHandsButton participants={raisedHandParticipants} />
            }
          />
        </Div>
      )}
      <ParticipantsCollapsableList<Participant>
        heading={t('contributors')}
        participants={sortedParticipants}
        renderParticipant={(participant) => (
          <ParticipantListItem
            key={participant.identity}
            participant={participant}
          />
        )}
        action={<MuteEveryoneButton participants={sortedRemoteParticipants} />}
      />
    </Div>
  )
}
