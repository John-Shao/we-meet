import { proxy } from 'valtio'

import type { RemoteInviteChip } from './CallStage'

/**
 * P5: co-participants' ringing invites (MEET_INVITES_TOPIC data messages),
 * keyed by the SENDER's LiveKit identity. Written by Conference's
 * CallOrMeeting (the only DataReceived subscriber), read by both the overlay
 * chips and the participants side panel's suggested tab — those live in
 * different component trees, hence a module store instead of prop drilling.
 *
 * Consumers must filter by senders still present in the room: a sender
 * leaving cancels their invites, so their snapshot is void (same rule the
 * overlay always applied).
 */
export const remoteInvitesStore = proxy<{
  bySender: Record<string, RemoteInviteChip[]>
}>({ bySender: {} })

export const resetRemoteInvites = (): void => {
  remoteInvitesStore.bySender = {}
}
