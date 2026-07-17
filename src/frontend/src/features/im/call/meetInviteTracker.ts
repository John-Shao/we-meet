import { proxy } from 'valtio'

import { CallEvent, type CallPayload, type Client } from '@jusi/light-im-sdk'

import { createDirectConversationByUserId } from '../api/createDirectConversation'

/**
 * P4 通话中拉人升级会议 — per-invitee escalation-invite tracker.
 *
 * Independent of the main callController state machine on purpose: that one is
 * a single-channel `Idle`-gated flow (one ringing call at a time), while an
 * escalation fans out N parallel 1:1 invites from INSIDE a live room. Each
 * invite is a standard P1 frame sent over the inviter↔invitee direct
 * conversation with `kind:"meet"` and the CURRENT room's slug (no new room),
 * so busy/unreachable/timeout semantics and the P2 offline push ride along
 * for free.
 *
 * Responsibilities (and nothing more): send + 3s×3 re-send + 60s timeout +
 * a per-invitee state chip for the voice grid. No room create, no navigation,
 * no call-log (a rejected meet-invite must not fake a "missed call" entry).
 */

/** Until @jusi/light-im-sdk 0.1.0-alpha.10 (P19) is installed, `kind` rides as
 * an extra key — the SDK sends the payload object verbatim. */
type MeetCallPayload = CallPayload & { kind?: '' | 'meet' }

export type MeetInviteState =
  | 'inviting' // frame(s) sent, no receipt yet
  | 'ringing' // invitee's device acked
  | 'accepted' // invitee accepted — room roster is the truth from here on
  | 'rejected'
  | 'busy'
  | 'unreachable'
  | 'timeout'
  | 'canceled' // we left the room while they rang
  | 'failed' // direct-conv resolve or socket failure

export interface MeetInvite {
  callId: string
  /** we-meet user id (picker output). */
  userId: string
  /** Display label captured at pick time (grid chip + fallbacks). */
  label: string
  state: MeetInviteState
  peerUid?: string
  cid?: string
}

export const meetInviteStore = proxy<{
  /** Latched the moment the FIRST invite of this room session goes out. */
  upgraded: boolean
  invites: MeetInvite[]
}>({ upgraded: false, invites: [] })

const RING_TIMEOUT_MS = 60_000
const RESEND_INTERVAL_MS = 3_000
const RESENDS = 3

const TERMINAL: ReadonlySet<MeetInviteState> = new Set([
  'accepted',
  'rejected',
  'busy',
  'unreachable',
  'timeout',
  'canceled',
  'failed',
])

let client: Client | null = null
let unsubscribe: (() => void) | null = null
const timers = new Map<
  string,
  { resend?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> }
>()

/** Wired from initCallController — same client, separate frame subscription. */
export const initMeetInviteTracker = (c: Client): void => {
  if (client === c) return
  unsubscribe?.()
  client = c
  unsubscribe = c.onCall(onFrame)
}

export interface MeetInviteTarget {
  userId: string
  label: string
}

export interface MeetInviteOpts {
  media: 'audio' | 'video'
  roomSlug: string
  /** e.g. t('call.meetInviteRoomName', {name}) — shown by older clients. */
  roomName: string
}

/**
 * Fan out escalation invites to the picked members. Latches `upgraded`
 * immediately (拍板: the inviter's UI upgrades on send, not on answer).
 */
export const sendMeetInvites = (
  targets: MeetInviteTarget[],
  opts: MeetInviteOpts
): void => {
  if (targets.length === 0) return
  meetInviteStore.upgraded = true
  for (const target of targets) {
    // Re-inviting someone whose previous attempt ended is a fresh call_id;
    // someone still inviting/ringing is skipped (single in-flight per person).
    const inFlight = meetInviteStore.invites.some(
      (i) => i.userId === target.userId && !TERMINAL.has(i.state)
    )
    if (inFlight) continue
    const invite: MeetInvite = {
      callId: crypto.randomUUID(),
      userId: target.userId,
      label: target.label,
      state: 'inviting',
    }
    meetInviteStore.invites.push(invite)
    void dispatch(invite, opts)
  }
}

/** Send `cancel` to every non-terminal invitee — called when the inviter
 * leaves the room (拍板 #1: the invite dies with the inviter's presence). */
export const cancelPendingMeetInvites = (): void => {
  for (const invite of meetInviteStore.invites) {
    if (TERMINAL.has(invite.state)) continue
    sendFrame(invite, CallEvent.Cancel, 'canceled')
    setState(invite.callId, 'canceled')
  }
}

/** Full reset on room unmount — the next call session starts un-upgraded. */
export const resetMeetInvites = (): void => {
  for (const t of timers.values()) {
    if (t.resend) clearInterval(t.resend)
    if (t.timeout) clearTimeout(t.timeout)
  }
  timers.clear()
  meetInviteStore.upgraded = false
  meetInviteStore.invites = []
}

// ---- internals ----

const dispatch = async (
  invite: MeetInvite,
  opts: MeetInviteOpts
): Promise<void> => {
  let cid: string
  let peerUid: string | undefined
  try {
    // Idempotent create-or-get; the backend resolves the peer's IM uid
    // org-scoped so the client never handles raw subs.
    const conv = await createDirectConversationByUserId(invite.userId)
    cid = conv.cid
    peerUid = conv.members.find((m) => m !== conv.self_uid)
  } catch {
    setState(invite.callId, 'failed')
    return
  }
  if (!peerUid) {
    setState(invite.callId, 'failed')
    return
  }
  const live = meetInviteStore.invites.find((i) => i.callId === invite.callId)
  if (!live || TERMINAL.has(live.state)) return // canceled while resolving
  live.cid = cid
  live.peerUid = peerUid

  if (!sendFrame(live, CallEvent.Invite, undefined, opts)) {
    setState(invite.callId, 'failed')
    return
  }
  startTimers(live, opts)
}

const startTimers = (invite: MeetInvite, opts: MeetInviteOpts): void => {
  let sent = 0
  const resend = setInterval(() => {
    const live = find(invite.callId)
    if (!live || live.state !== 'inviting' || sent >= RESENDS) {
      clearInterval(resend)
      return
    }
    sent += 1
    sendFrame(live, CallEvent.Invite, undefined, opts)
  }, RESEND_INTERVAL_MS)
  const timeout = setTimeout(() => {
    const live = find(invite.callId)
    if (!live || TERMINAL.has(live.state)) return
    sendFrame(live, CallEvent.Cancel, 'timeout')
    setState(invite.callId, 'timeout')
  }, RING_TIMEOUT_MS)
  timers.set(invite.callId, { resend, timeout })
}

const onFrame = (p: CallPayload): void => {
  const invite = find(p.call_id)
  if (!invite || !invite.peerUid || p.from !== invite.peerUid) return
  switch (p.event) {
    case CallEvent.Ringing:
      if (invite.state === 'inviting') setState(invite.callId, 'ringing')
      break
    case CallEvent.Accept:
      // From here the room roster is the truth source; the chip is only a
      // transient "on their way" hint.
      setState(invite.callId, 'accepted')
      break
    case CallEvent.Reject:
      setState(invite.callId, 'rejected')
      break
    case CallEvent.Busy:
      setState(invite.callId, 'busy')
      break
    case CallEvent.Unreachable:
      // Only reaches us when offline push is NOT configured server-side —
      // with push, the invitee's phone is being woken instead.
      setState(invite.callId, 'unreachable')
      break
  }
}

const sendFrame = (
  invite: MeetInvite,
  event: CallPayload['event'],
  reason?: string,
  opts?: MeetInviteOpts
): boolean => {
  const c = client
  if (!c || !invite.cid || !invite.peerUid) return false
  try {
    const payload: MeetCallPayload = {
      event,
      call_id: invite.callId,
      cid: invite.cid,
      to: invite.peerUid,
      reason,
      ...(event === CallEvent.Invite && opts
        ? {
            kind: 'meet' as const,
            media: opts.media,
            room_slug: opts.roomSlug,
            room_name: opts.roomName,
          }
        : {}),
    }
    c.sendCall(payload)
    return true
  } catch {
    return false
  }
}

const find = (callId: string): MeetInvite | undefined =>
  meetInviteStore.invites.find((i) => i.callId === callId)

const setState = (callId: string, state: MeetInviteState): void => {
  const invite = find(callId)
  if (!invite || TERMINAL.has(invite.state)) return
  invite.state = state
  if (TERMINAL.has(state)) {
    const t = timers.get(callId)
    if (t?.resend) clearInterval(t.resend)
    if (t?.timeout) clearTimeout(t.timeout)
    timers.delete(callId)
  }
}
