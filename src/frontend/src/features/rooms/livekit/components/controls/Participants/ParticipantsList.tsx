import { useMemo, useState } from 'react'
import { css } from '@/styled-system/css'
import { useParticipants } from '@livekit/components-react'
import { useQuery } from '@tanstack/react-query'
import { useSnapshot } from 'valtio'
import { RiUserAddLine } from '@remixicon/react'

import { Button, Div, H } from '@/primitives'
import { useTranslation } from 'react-i18next'
import { useUser } from '@/features/auth'
import { useRoomData } from '../../../hooks/useRoomData'
import { resolveRoomUsers } from '@/features/im/api/resolveRoomUsers'
import { meetInviteStore } from '@/features/im/call/meetInviteTracker'
import { UnifiedInvitePanel } from '@/features/rooms/components/UnifiedInvitePanel'
import { remoteInvitesStore } from '@/features/rooms/components/remoteInvitesStore'
import { fetchSuggestedParticipants } from '@/features/rooms/api/suggestedParticipants'
import { SuggestedParticipantsList } from './SuggestedParticipantsList'
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

  // ---- P5 建议参会 (设计 §5.1) ----
  // Invited list from the backend; presence subtraction is LOCAL: a
  // suggestion whose sub is in the live roster has "moved to the 全部 tab".
  const [tab, setTab] = useState<'all' | 'suggested'>('all')
  const [query, setQuery] = useState('')
  const { data: allSuggestions = [] } = useQuery({
    queryKey: ['rooms', roomSlug, 'suggested-participants'],
    queryFn: () => fetchSuggestedParticipants(roomSlug!),
    enabled: !!roomSlug,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const presentSubs = useMemo(
    () => new Set(participants.map((p) => p.identity)),
    [participants]
  )
  const suggested = allSuggestions.filter(
    (s) => !s.is_self && !presentSubs.has(s.sub)
  )

  // Ringing signals for the suggested rows: my own in-flight invites keep
  // their rows visible states; co-participants' broadcasts dim theirs.
  useSnapshot(meetInviteStore) // re-render on my invite state changes
  const remoteSnap = useSnapshot(remoteInvitesStore)
  const remoteRingingUserIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [sender, chips] of Object.entries(remoteSnap.bySender)) {
      if (!presentSubs.has(sender)) continue // leaver's snapshot is void
      for (const chip of chips) if (chip.userId) ids.add(chip.userId)
    }
    return ids
  }, [remoteSnap, presentSubs])

  // Search filters BOTH tabs locally (设计: 搜索或呼叫 box).
  const q = query.trim().toLowerCase()
  const matchesName = (name: string) => !q || name.toLowerCase().includes(q)
  const filteredSuggested = suggested.filter((s) =>
    matchesName([s.full_name, s.short_name, s.email].filter(Boolean).join(' '))
  )
  const filterParticipants = <T extends Participant>(list: T[]): T[] =>
    q ? list.filter((p) => p && matchesName(p.name || p.identity)) : list
  const filteredSorted = filterParticipants(sortedParticipants)
  const filteredRaised = filterParticipants(raisedHandParticipants)
  const filteredWaiting = q
    ? waitingParticipants.filter((p) => matchesName(p.username))
    : waitingParticipants

  const tabCls = (active: boolean) =>
    css({
      flex: 1,
      paddingY: '0.4375rem',
      border: 'none',
      borderBottom: active
        ? '2px solid token(colors.primary.500)'
        : '2px solid transparent',
      backgroundColor: 'transparent',
      color: active ? 'primary.600' : 'greyscale.600',
      fontSize: '0.8125rem',
      fontWeight: active ? 'bold' : 'normal',
      cursor: 'pointer',
    })

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
      {/* P5: search-or-call box + invite button (Feishu-style header). */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          margin: '0 1.5rem 0.625rem',
        })}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchOrCall')}
          data-testid="participants-search"
          className={css({
            flex: 1,
            minWidth: 0,
            paddingX: '0.625rem',
            paddingY: '0.375rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            fontSize: '0.8125rem',
          })}
        />
        {roomSlug && (
          <Button
            variant="primary"
            size="dense"
            onPress={() => setInviteOpen(true)}
            data-testid="participants-invite-members"
          >
            <RiUserAddLine size={16} />
            {t('inviteAction')}
          </Button>
        )}
      </div>
      {/* P5: 全部 / 建议参会 tabs — counts live-update (suggested excludes
          present people, so someone joining moves across immediately). */}
      <div
        className={css({
          display: 'flex',
          margin: '0 1.5rem 0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <button
          type="button"
          onClick={() => setTab('all')}
          data-testid="participants-tab-all"
          className={tabCls(tab === 'all')}
        >
          {t('tabAll', { count: participants.length })}
        </button>
        <button
          type="button"
          onClick={() => setTab('suggested')}
          data-testid="participants-tab-suggested"
          className={tabCls(tab === 'suggested')}
        >
          {t('tabSuggested', { count: suggested.length })}
        </button>
      </div>
      {inviteOpen && roomSlug && (
        <UnifiedInvitePanel
          roomSlug={roomSlug}
          excludeUserIds={excludeUserIds}
          // 实测问题2: 面板搜索词带进 picker,输入不白打。
          initialQuery={query.trim() || undefined}
          onClose={() => setInviteOpen(false)}
        />
      )}
      {tab === 'suggested' ? (
        roomSlug && (
          <SuggestedParticipantsList
            suggestions={filteredSuggested}
            roomSlug={roomSlug}
            inviterName={user?.full_name ?? ''}
            remoteRingingUserIds={remoteRingingUserIds}
          />
        )
      ) : (
        <>
          {filteredWaiting?.length > 0 && (
            <Div marginBottom=".9375rem">
              <ParticipantsCollapsableList<WaitingParticipant>
                heading={t('waiting.title')}
                participants={filteredWaiting}
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
          {filteredRaised.length > 0 && (
            <Div marginBottom=".9375rem">
              <ParticipantsCollapsableList<Participant>
                heading={t('raisedHands')}
                participants={filteredRaised}
                renderParticipant={(participant) => (
                  <HandRaisedListItem
                    key={participant.identity}
                    participant={participant}
                  />
                )}
                action={<LowerAllHandsButton participants={filteredRaised} />}
              />
            </Div>
          )}
          <ParticipantsCollapsableList<Participant>
            heading={t('contributors')}
            participants={filteredSorted}
            renderParticipant={(participant) => (
              <ParticipantListItem
                key={participant.identity}
                participant={participant}
              />
            )}
            action={
              <MuteEveryoneButton participants={sortedRemoteParticipants} />
            }
          />
        </>
      )}
    </Div>
  )
}
