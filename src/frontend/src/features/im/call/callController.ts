import { proxy } from 'valtio'

import {
  CallEvent,
  type CallMedia,
  type CallPayload,
  type Client,
} from '@jusi/light-im-sdk'

import { fetchApi } from '@/api/fetchApi'
import { navigateTo } from '@/navigation/navigateTo'

import { fetchImToken } from '../api/fetchImToken'
import {
  initMeetInviteTracker,
  sendMeetInvites,
  type MeetInviteTarget,
} from './meetInviteTracker'
import type { ApiRoom } from '@/features/rooms/api/ApiRoom'
import { reportSuggestedParticipants } from '@/features/rooms/api/suggestedParticipants'

/**
 * P1 一对一通话 — web/desktop call state machine. Mirrors the Android
 * CallController (feature-im/call/CallController.kt) so both ends speak the
 * same protocol over the transient `call` WS frame:
 *
 *  - the SERVER is a stateless validating relay; everything stateful is here
 *  - call_id idempotency (late/duplicate frames for a finished call drop)
 *  - invite re-send 3s × 3 until the callee's `ringing` receipt
 *  - independent 60s timeouts on BOTH sides (neither trusts the other's clock)
 *  - busy auto-reply when an invite lands while not idle
 *  - multi-device convergence: terminal frames are double-published by the
 *    server; an echo of my own accept/reject on another device closes the
 *    local attempt ("answered elsewhere")
 *  - the caller creates the LiveKit room BEFORE inviting (slug rides in the
 *    invite) and ends it on every non-connected terminal (no zombie rooms);
 *    the callee just navigates to /{room_slug} on accept
 *  - non-connected terminals persist a `call-log` chat message (caller side
 *    only, so exactly one party writes it)
 */

export type CallEndReason =
  | 'canceled' // I canceled
  | 'canceledRemote' // caller canceled / timed out while I rang
  | 'declined' // peer rejected my call
  | 'declinedLocal' // I rejected
  | 'timeout' // 60s, no answer
  | 'busy' // peer busy
  | 'unreachable' // peer offline (server short-circuit)
  | 'answeredElsewhere' // another of my devices took it
  | 'declinedElsewhere' // another of my devices rejected it
  | 'failed' // room create or socket failure

export interface CallInfo {
  callId: string
  cid: string
  peerUid: string
  peerName: string
  peerAvatar?: string
  media: CallMedia
  outgoing: boolean
  roomSlug?: string
  roomId?: string
  /** P4: "meet" (1:1 escalation / meeting pull) or "group" (群语音) mark an
   * invite into an existing multi-party room — the overlay swaps the ring
   * text and accept lands in the multi-party form instead of the 1:1 stage.
   * Only "meet" writes the invitee-side direct-chat record. */
  kind?: '' | 'meet' | 'group'
}

export type CallPhase =
  | { phase: 'idle' }
  | { phase: 'outgoing'; info: CallInfo; waitingAnswer: boolean }
  | { phase: 'incoming'; info: CallInfo }
  | { phase: 'connecting'; info: CallInfo }
  /** Transient — the overlay shows the reason briefly, then we reset to idle. */
  | { phase: 'ended'; info: CallInfo; reason: CallEndReason }

export const callStore = proxy<{ state: CallPhase }>({
  state: { phase: 'idle' },
})

const RING_TIMEOUT_MS = 60_000
const INVITE_RESEND_INTERVAL_MS = 3_000
const INVITE_RESENDS = 3
const ENDED_LINGER_MS = 2_500
const FINISHED_CACHE = 32

let client: Client | null = null
let selfUid = ''
let unsubscribe: (() => void) | null = null
let timeoutTimer: ReturnType<typeof setTimeout> | null = null
let resendTimer: ReturnType<typeof setInterval> | null = null
let lingerTimer: ReturnType<typeof setTimeout> | null = null
const finishedCallIds: string[] = []

/** A connected 1:1 call in flight on this device as the caller (drives the duration log). */
let connectedCall: { cid: string; media: CallMedia; startedAt: number } | null =
  null

/** P4: a meet-invite this device ACCEPTED (drives the invitee-side record —
 * the invitee writes `completed`+duration into the inviter↔invitee direct
 * conversation on leave, so both of them see the record; the tracker itself
 * never writes logs). */
let connectedMeetCall: {
  cid: string
  media: CallMedia
  startedAt: number
} | null = null

/** P4.1: a group voice call this device INITIATED — drives the GROUP-chat
 * record on leave: `completed` + duration anchored at the FIRST answer
 * (WeChat口径, ring-wait excluded), or `canceled` when nobody ever joined.
 * connectedAt is stamped by the room UI (CallStage) via
 * [markGroupCallConnected] the moment a remote appears. */
let groupCall: {
  cid: string
  /** Room slug — stamped into the end-record so the ongoing card (same slug)
   * can render as ended. */
  slug: string
  connectedAt: number | null
  /** P5.1: 'audio' (群语音) or 'video' (群视频会议) — stamped into the
   * end-record so the card wording matches the session. */
  media: 'audio' | 'video'
} | null = null

/** Stamped by CallStage when the first remote participant shows up. Idempotent
 * and a no-op outside group-call sessions. */
export const markGroupCallConnected = (): void => {
  if (groupCall && groupCall.connectedAt === null) {
    groupCall.connectedAt = Date.now()
  }
}

/** Whether this device is currently inside a room (meeting OR 1:1/群 call).
 * Toggled by Conference on mount/unmount. Used to auto-busy an incoming 1:1
 * invite that lands while already in a room — note a *connected* 1:1 call has
 * callStore back at `idle` (set on room entry), so the phase check alone can't
 * see it; this flag is the reliable signal. A plain flag (not showHeader) so
 * the cold-load default showHeader=false never spuriously replies Busy. */
let inMeeting = false
export const setInMeeting = (v: boolean): void => {
  inMeeting = v
}

/**
 * Wire the controller to the app-wide SDK client. Idempotent; called from
 * ImUnreadProvider (the same place that keeps the client connected app-wide),
 * so incoming calls ring on ANY page, not just /im.
 */
export const initCallController = (c: Client) => {
  if (client === c) return
  unsubscribe?.()
  client = c
  unsubscribe = c.onCall(onFrame)
  // P4: the escalation-invite tracker shares the client but runs its own
  // parallel per-invitee mini state machines (this controller stays 1:1).
  initMeetInviteTracker(c)
  // Cache our own jusi uid for multi-device echo filtering. Best-effort — if
  // it fails, the echo check degrades gracefully (worst case: an own-device
  // echo shows "answered elsewhere" slightly less precisely).
  void fetchImToken()
    .then((t) => {
      selfUid = t.uid
    })
    .catch(() => undefined)
}

// ---- caller side ----

export interface StartCallParams {
  cid: string
  peerUid: string
  peerName: string
  peerAvatar?: string
  media: CallMedia
  /** Localized room name, e.g. t('call.roomName', {name}) → 与X的通话. */
  roomName: string
  /** username query for room creation (display name, mirrors Home). */
  username: string
}

export const startCall = async (p: StartCallParams): Promise<void> => {
  const c = client
  if (!c) return
  if (callStore.state.phase !== 'idle') {
    // Busy locally — the UI disables the buttons, this is just a backstop.
    return
  }
  const info: CallInfo = {
    callId: crypto.randomUUID(),
    cid: p.cid,
    peerUid: p.peerUid,
    peerName: p.peerName,
    peerAvatar: p.peerAvatar,
    media: p.media,
    outgoing: true,
  }
  callStore.state = { phase: 'outgoing', info, waitingAnswer: false }

  let room: ApiRoom
  try {
    room = await fetchApi<ApiRoom>(
      `rooms/?username=${encodeURIComponent(p.username)}`,
      { method: 'POST', body: JSON.stringify({ name: p.roomName }) }
    )
  } catch {
    finish(info, 'failed')
    return
  }
  // The user may have canceled while the room was being created.
  const cur = callStore.state
  if (cur.phase !== 'outgoing' || cur.info.callId !== info.callId) {
    void endRoomQuietly(room.id)
    return
  }
  const withRoom: CallInfo = { ...info, roomSlug: room.slug, roomId: room.id }
  callStore.state = { phase: 'outgoing', info: withRoom, waitingAnswer: false }

  if (!sendFrame(withRoom, CallEvent.Invite)) {
    finish(withRoom, 'failed', { endRoom: true })
    return
  }
  startInviteResend(withRoom)
  startTimeout(withRoom, /*asCaller=*/ true)
}

/**
 * P4.1 群语音通话: create the room, ring the picked group members (parallel
 * meet-invites), enter the voice grid. No Outgoing state — there is no single
 * callee to wait on; the grid's ringing chips ARE the waiting UI, and the
 * "alone + no pending invites → auto-end" semantics converge every outcome.
 */
export const startGroupVoiceCall = async (p: {
  /** The GROUP conversation — receives the call-log record on leave. */
  groupCid: string
  /** Room name AND the invite frame's room_name,「{群名}的语音通话」/
   *「{群名}的视频会议」. */
  roomName: string
  /** Display name for room creation (mirrors startCall). */
  username: string
  targets: MeetInviteTarget[]
  /** P5.1 群视频会议走同一条振铃管线: 'audio' (default,语音宫格) or
   * 'video' (initiator + invitees land in the full meeting UI). */
  media?: 'audio' | 'video'
  /** P5 建议参会: the FULL group roster (picked or not) — reported as the
   * room's suggested invitees so the in-meeting participants panel offers
   * every group member for (re-)calling, Feishu-style. */
  suggestUserIds?: string[]
}): Promise<void> => {
  if (!client || p.targets.length === 0) return
  if (callStore.state.phase !== 'idle') return
  const media = p.media ?? 'audio'
  let room: ApiRoom
  try {
    room = await fetchApi<ApiRoom>(
      `rooms/?username=${encodeURIComponent(p.username)}`,
      { method: 'POST', body: JSON.stringify({ name: p.roomName }) }
    )
  } catch {
    return // room create failed — button stays enabled, user can retry
  }
  groupCall = { cid: p.groupCid, slug: room.slug, connectedAt: null, media }
  // P5: fire-and-forget — ringing never blocks on suggestion bookkeeping.
  reportSuggestedParticipants(
    room.slug,
    p.suggestUserIds ?? p.targets.map((t) => t.userId),
    'group'
  )
  // P4.1 进行中卡片: every group member (rung or not) sees a joinable card;
  // the end-record below flips it to the ended state.
  try {
    await client.sendText(
      p.groupCid,
      JSON.stringify({ slug: room.slug, media }),
      { contentType: 'group-call' }
    )
  } catch {
    // Best-effort — the ringing invites still go out.
  }
  sendMeetInvites(p.targets, {
    media,
    roomSlug: room.slug,
    roomName: p.roomName,
    kind: 'group',
  })
  navigateTo('room', room.slug, {
    state: { autoJoin: true, callAudioOnly: media !== 'video', callMeet: true },
  })
}

export const cancelCall = (): void => {
  const s = callStore.state
  if (s.phase !== 'outgoing') return
  sendFrame(s.info, CallEvent.Cancel, 'canceled')
  void sendCallLog(s.info, 'canceled')
  finish(s.info, 'canceled', { endRoom: true })
}

// ---- callee side ----

export const acceptCall = (): void => {
  const s = callStore.state
  if (s.phase !== 'incoming') return
  const slug = s.info.roomSlug
  if (!slug) {
    finish(s.info, 'failed')
    return
  }
  callStore.state = { phase: 'connecting', info: s.info }
  sendFrame(s.info, CallEvent.Accept)
  // P4: an accepted meet-invite gets an invitee-side duration record (拍板:
  // the invitee is the single writer in the inviter↔invitee conversation).
  // 群语音 (kind="group") deliberately does NOT — the group chat carries the
  // single record (P4.1 实测拍板).
  if (s.info.kind === 'meet') {
    connectedMeetCall = {
      cid: s.info.cid,
      media: s.info.media,
      startedAt: Date.now(),
    }
  }
  enterRoom(slug, s.info)
  finishQuietly(s.info)
}

export const rejectCall = (): void => {
  const s = callStore.state
  if (s.phase !== 'incoming') return
  sendFrame(s.info, CallEvent.Reject, 'declined')
  finish(s.info, 'declinedLocal')
}

// ---- inbound frames ----

const onFrame = (p: CallPayload): void => {
  switch (p.event) {
    case CallEvent.Invite:
      onInvite(p)
      break
    case CallEvent.Ringing:
      onRinging(p)
      break
    case CallEvent.Accept:
      onAccept(p)
      break
    case CallEvent.Reject:
      onTerminal(p, 'declined', 'declined')
      break
    case CallEvent.Cancel:
      onTerminal(p, 'canceledRemote', null)
      break
    case CallEvent.Busy:
      onTerminal(p, 'busy', 'busy')
      break
    case CallEvent.Hangup:
      onTerminal(p, 'canceledRemote', null)
      break
    case CallEvent.Unreachable:
      onTerminal(p, 'unreachable', 'unreachable')
      break
  }
}

const onInvite = (p: CallPayload): void => {
  const from = p.from
  if (!from || from === selfUid) return
  if (finishedCallIds.includes(p.call_id)) return
  const cur = callStore.state
  if (cur.phase !== 'idle') {
    const activeId = 'info' in cur ? cur.info.callId : undefined
    if (activeId === p.call_id) {
      // Caller's re-send for the call we're already ringing on — re-ack.
      replyTo(p, CallEvent.Ringing)
    } else {
      replyTo(p, CallEvent.Busy, 'busy')
    }
    return
  }
  // 已在会中/通话中(此时本机呼叫态已是 idle,靠 inMeeting 才看得见)——立刻回
  // Busy,让对端马上收到「忙线」而不是干听 60s 回铃。对端 onTerminal(busy) 结束。
  if (inMeeting) {
    replyTo(p, CallEvent.Busy, 'busy')
    return
  }
  const info: CallInfo = {
    callId: p.call_id,
    cid: p.cid,
    peerUid: from,
    // Display name/avatar are resolved by the overlay via resolveImUsers;
    // the uid is only the fallback.
    peerName: from,
    media: p.media ?? 'audio',
    outgoing: false,
    roomSlug: p.room_slug,
    // P4: escalation invites carry kind (P19; "group" rides verbatim beyond
    // the SDK's ''|'meet' typing).
    kind: p.kind as CallInfo['kind'],
  }
  callStore.state = { phase: 'incoming', info }
  replyTo(p, CallEvent.Ringing)
  startTimeout(info, /*asCaller=*/ false)
}

const onRinging = (p: CallPayload): void => {
  const s = callStore.state
  if (s.phase !== 'outgoing' || s.info.callId !== p.call_id) return
  stopResend()
  if (!s.waitingAnswer) {
    callStore.state = { phase: 'outgoing', info: s.info, waitingAnswer: true }
  }
}

const onAccept = (p: CallPayload): void => {
  const s = callStore.state
  if (!('info' in s) || s.info.callId !== p.call_id) return
  if (s.phase === 'outgoing') {
    const slug = s.info.roomSlug
    if (!slug) {
      finish(s.info, 'failed', { endRoom: true })
      return
    }
    // Track the connected call so leaving the room can persist the
    // "通话时长 mm:ss" log (caller side only — one party writes records).
    connectedCall = {
      cid: s.info.cid,
      media: s.info.media,
      startedAt: Date.now(),
    }
    enterRoom(slug, s.info)
    finishQuietly(s.info)
  } else if (s.phase === 'incoming' && p.from === selfUid) {
    // Another of MY devices answered (terminal double-publish echo).
    finish(s.info, 'answeredElsewhere')
  }
}

const onTerminal = (
  p: CallPayload,
  reason: CallEndReason,
  logResult: string | null
): void => {
  const s = callStore.state
  if (!('info' in s) || s.info.callId !== p.call_id) return
  if (p.from === selfUid) {
    // My own echo of a terminal I initiated — already handled locally. On a
    // still-ringing OTHER device of mine, converge with the right label: an
    // echoed reject means "declined elsewhere", not "answered".
    if (s.phase === 'incoming') {
      finish(
        s.info,
        reason === 'declined' ? 'declinedElsewhere' : 'answeredElsewhere'
      )
    }
    return
  }
  if (s.info.outgoing && logResult) void sendCallLog(s.info, logResult)
  finish(s.info, reason, { endRoom: s.info.outgoing })
}

/**
 * End-of-room-session bookkeeping, debounced against transient unmounts.
 *
 * Conference schedules the flush on unmount and CANCELS it on (re)mount: a
 * StrictMode double-mount or any router-induced unmount/remount blip would
 * otherwise consume [connectedCall] seconds into the call and persist a
 * bogus "00:01" duration log (P4 实测问题7). The duration is anchored to the
 * moment of the LAST unmount, so the grace window never inflates it.
 *
 * On flush: if a connected 1:1 call was in flight on this device as the
 * CALLER, persist the "completed + duration" call-log (plain meetings and
 * callee-side sessions no-op — connectedCall is only set on the caller's
 * accept), then run [extra] (P4: cancel still-ringing escalation invites).
 */
const LEAVE_GRACE_MS = 2_000
let leaveTimer: ReturnType<typeof setTimeout> | null = null

export const scheduleCallRoomLeave = (extra?: () => void): void => {
  const leftAtMs = Date.now()
  if (leaveTimer) clearTimeout(leaveTimer)
  leaveTimer = setTimeout(() => {
    leaveTimer = null
    const c = connectedCall
    if (c) {
      connectedCall = null
      const durationSec = Math.max(
        1,
        Math.round((leftAtMs - c.startedAt) / 1000)
      )
      void sendCallLog(
        { cid: c.cid, media: c.media } as CallInfo,
        'completed',
        durationSec
      )
    }
    const m = connectedMeetCall
    if (m) {
      connectedMeetCall = null
      const durationSec = Math.max(
        1,
        Math.round((leftAtMs - m.startedAt) / 1000)
      )
      void sendCallLog(
        { cid: m.cid, media: m.media } as CallInfo,
        'completed',
        durationSec
      )
    }
    // P4.1: the group-call record lands in the GROUP conversation. Duration
    // counts from the first answer; a call nobody joined logs as canceled.
    const g = groupCall
    if (g) {
      groupCall = null
      if (g.connectedAt !== null) {
        const durationSec = Math.max(
          1,
          Math.round((leftAtMs - g.connectedAt) / 1000)
        )
        void sendCallLog(
          { cid: g.cid, media: g.media } as CallInfo,
          'completed',
          durationSec,
          g.slug
        )
      } else {
        void sendCallLog(
          { cid: g.cid, media: g.media } as CallInfo,
          'canceled',
          undefined,
          g.slug
        )
      }
    }
    extra?.()
  }, LEAVE_GRACE_MS)
}

/** The room screen (re)mounted within the grace window — not a real leave. */
export const cancelCallRoomLeave = (): void => {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
}

// ---- timers ----

const startInviteResend = (info: CallInfo): void => {
  stopResend()
  let sent = 0
  resendTimer = setInterval(() => {
    const s = callStore.state
    if (
      s.phase !== 'outgoing' ||
      s.info.callId !== info.callId ||
      s.waitingAnswer ||
      sent >= INVITE_RESENDS
    ) {
      stopResend()
      return
    }
    sent += 1
    sendFrame(s.info, CallEvent.Invite)
  }, INVITE_RESEND_INTERVAL_MS)
}

const startTimeout = (info: CallInfo, asCaller: boolean): void => {
  if (timeoutTimer) clearTimeout(timeoutTimer)
  timeoutTimer = setTimeout(() => {
    const s = callStore.state
    if (!('info' in s) || s.info.callId !== info.callId) return
    if (s.phase !== 'outgoing' && s.phase !== 'incoming') return
    if (asCaller) {
      sendFrame(s.info, CallEvent.Cancel, 'timeout')
      void sendCallLog(s.info, 'missed')
    }
    finish(s.info, asCaller ? 'timeout' : 'canceledRemote', {
      endRoom: asCaller,
    })
  }, RING_TIMEOUT_MS)
}

// ---- plumbing ----

const sendFrame = (
  info: CallInfo,
  event: CallPayload['event'],
  reason?: string
): boolean => {
  const c = client
  if (!c) return false
  try {
    c.sendCall({
      event,
      call_id: info.callId,
      cid: info.cid,
      to: info.peerUid,
      media: info.media,
      room_slug: info.roomSlug,
      reason,
    })
    return true
  } catch {
    return false
  }
}

const replyTo = (
  p: CallPayload,
  event: CallPayload['event'],
  reason?: string
): void => {
  const c = client
  const to = p.from
  if (!c || !to) return
  try {
    c.sendCall({ event, call_id: p.call_id, cid: p.cid, to, reason })
  } catch {
    // Socket hiccup — the peer's own timeout converges the attempt.
  }
}

/** 拍板 #2: persist the attempt as a call-log chat message (caller only). */
const sendCallLog = async (
  info: CallInfo,
  result: string,
  durationSec?: number,
  slug?: string
): Promise<void> => {
  const c = client
  if (!c) return
  try {
    await c.sendText(
      info.cid,
      JSON.stringify({
        media: info.media,
        result,
        ...(durationSec ? { duration: durationSec } : {}),
        // P4.1: ties the group end-record to its ongoing card. Renderers of
        // plain call-logs ignore unknown fields.
        ...(slug ? { slug } : {}),
      }),
      { contentType: 'call-log' }
    )
  } catch {
    // Best-effort — losing the log must not break call teardown.
  }
}

const enterRoom = (slug: string, info: CallInfo): void => {
  navigateTo('room', slug, {
    state: {
      // Skip the Join preview — the user already committed by calling/answering.
      autoJoin: true,
      // 语音通话 enters with the camera off (does not touch saved preferences).
      callAudioOnly: info.media === 'audio',
      // Peer identity for the minimal in-call UI. Router state is the only
      // carrier: the callStore resets the moment we navigate (finishQuietly),
      // and LiveKit participants carry no photo.
      callPeer: {
        uid: info.peerUid,
        name: info.peerName,
        avatar: info.peerAvatar,
      },
      // P4: an accepted escalation invite lands straight in the multi-party
      // form — voice keeps the minimal stage but grid-seeded, video goes to
      // the full meeting UI.
      callMeet: info.kind === 'meet' || info.kind === 'group',
    },
  })
}

const endRoomQuietly = async (roomId: string | undefined): Promise<void> => {
  if (!roomId) return
  try {
    await fetchApi(`rooms/${roomId}/end/`, { method: 'POST' })
  } catch {
    // Owner-only endpoint; failures leave an idle trusted room behind, which
    // is harmless (no media cost) — same acceptance as Android P1.
  }
}

const finish = (
  info: CallInfo,
  reason: CallEndReason,
  opts: { endRoom?: boolean } = {}
): void => {
  rememberFinished(info.callId)
  clearTimers()
  if (opts.endRoom) void endRoomQuietly(info.roomId)
  callStore.state = { phase: 'ended', info, reason }
  lingerTimer = setTimeout(() => {
    const s = callStore.state
    if (s.phase === 'ended' && s.info.callId === info.callId) {
      callStore.state = { phase: 'idle' }
    }
  }, ENDED_LINGER_MS)
}

/** Terminal without the "ended" toast phase — used when handing off to the room. */
const finishQuietly = (info: CallInfo): void => {
  rememberFinished(info.callId)
  clearTimers()
  callStore.state = { phase: 'idle' }
}

const rememberFinished = (callId: string): void => {
  finishedCallIds.push(callId)
  while (finishedCallIds.length > FINISHED_CACHE) finishedCallIds.shift()
}

const stopResend = (): void => {
  if (resendTimer) {
    clearInterval(resendTimer)
    resendTimer = null
  }
}

const clearTimers = (): void => {
  stopResend()
  if (timeoutTimer) {
    clearTimeout(timeoutTimer)
    timeoutTimer = null
  }
  if (lingerTimer) {
    clearTimeout(lingerTimer)
    lingerTimer = null
  }
}
