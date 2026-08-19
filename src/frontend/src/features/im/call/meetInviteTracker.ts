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
  /** Presigned avatar URL captured at pick time (dimmed grid chip). */
  avatarUrl?: string
  state: MeetInviteState
  peerUid?: string
  cid?: string
  /** P4-M3 未接记录用:发邀时的媒介与 kind(group 邀请不落 direct 记录)。 */
  media?: 'audio' | 'video'
  kind?: 'meet' | 'group'
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
  {
    resend?: ReturnType<typeof setInterval>
    timeout?: ReturnType<typeof setTimeout>
  }
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
  avatarUrl?: string
}

export interface MeetInviteOpts {
  media: 'audio' | 'video'
  roomSlug: string
  /** e.g. t('call.meetInviteRoomName', {name}) — shown by older clients. */
  roomName: string
  /** 'meet' (1:1 escalation / meeting pull — invitee writes the direct-chat
   * record) vs 'group' (群语音 — only the GROUP record exists; the invitee
   * must NOT double-log into the direct chat). Relayed verbatim by jusi. */
  kind?: 'meet' | 'group'
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
      avatarUrl: target.avatarUrl,
      state: 'inviting',
      media: opts.media,
      kind: opts.kind ?? 'meet',
    }
    meetInviteStore.invites.push(invite)
    void dispatch(invite, opts)
  }
}

/** P5 建议参会: cancel ONE in-flight invite (per-row ✕ in the suggested
 * tab) — same frame + state transition as the leave-room bulk cancel. */
export const cancelMeetInvite = (callId: string): void => {
  const invite = find(callId)
  if (!invite || TERMINAL.has(invite.state)) return
  sendFrame(invite, CallEvent.Cancel, 'canceled')
  setState(invite.callId, 'canceled')
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
    const payload: CallPayload = {
      event,
      call_id: invite.callId,
      cid: invite.cid,
      to: invite.peerUid,
      reason,
      ...(event === CallEvent.Invite && opts
        ? {
            kind: opts.kind ?? 'meet',
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

/** P4-M3 未接会议邀请 → call-log result 映射(accepted 由离房结算写
 * completed;failed 多半连 cid 都没有;group 邀请不落 direct 记录)。 */
const MISS_RESULT: Partial<Record<MeetInviteState, string>> = {
  timeout: 'missed',
  rejected: 'declined',
  busy: 'busy',
  unreachable: 'unreachable',
  canceled: 'canceled',
}

const setState = (callId: string, state: MeetInviteState): void => {
  const invite = find(callId)
  if (!invite || TERMINAL.has(invite.state)) return
  invite.state = state
  if (TERMINAL.has(state)) {
    const t = timers.get(callId)
    if (t?.resend) clearInterval(t.resend)
    if (t?.timeout) clearTimeout(t.timeout)
    timers.delete(callId)
    // P4-M3: 未接通的 meet 邀请落一条 A↔C「会议邀请」记录(body 带
    // kind:'meet',渲染为「会议邀请 · 未接/已拒绝…」而非未接来电——
    // M1 当年不写记录正是为了防伪装成未接电话,样式化后解禁)。
    const result = MISS_RESULT[state]
    if (result && invite.cid && invite.kind !== 'group' && client) {
      void client
        .sendText(
          invite.cid,
          JSON.stringify({
            media: invite.media ?? 'audio',
            result,
            kind: 'meet',
          }),
          { contentType: 'call-log' }
        )
        .catch(() => undefined)
    }
  }
}
