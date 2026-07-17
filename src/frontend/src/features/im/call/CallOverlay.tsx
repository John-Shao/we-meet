import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useSnapshot } from 'valtio'
import { css } from '@/styled-system/css'
import { RiPhoneFill, RiPhoneLine, RiVidiconLine } from '@remixicon/react'

import { Avatar } from '../components/Avatar'
import { resolveImUsers } from '../api/resolveImUsers'
import {
  acceptCall,
  callStore,
  cancelCall,
  rejectCall,
  type CallEndReason,
  type CallInfo,
} from './callController'

/**
 * P1 一对一通话 — app-wide call overlay (呼出 / 来电 / 接通中 / 终态提示).
 * Mounted once in ImUnreadProvider so incoming calls ring on ANY page,
 * matching Feishu's desktop behaviour. Layout follows the mobile design:
 * centered avatar + name + status line, action buttons at the bottom.
 */
export const CallOverlay = () => {
  const { t } = useTranslation('im')
  const snap = useSnapshot(callStore)
  const state = snap.state

  const info: CallInfo | null =
    'info' in state ? (state.info as CallInfo) : null

  // Resolve the peer's display name/avatar (incoming carries only the uid).
  const { data: names } = useQuery({
    queryKey: ['im', 'resolve', info?.peerUid],
    queryFn: () => resolveImUsers([info!.peerUid]),
    enabled: !!info,
    staleTime: 300_000,
  })
  const resolved = info ? names?.[info.peerUid] : undefined
  const displayName =
    resolved?.full_name || resolved?.short_name || info?.peerName || ''
  const avatarUrl = resolved?.avatar_url || info?.peerAvatar

  if (state.phase === 'idle' || !info) return null

  const statusText = (() => {
    switch (state.phase) {
      case 'outgoing':
        return state.waitingAnswer
          ? t('call.waitingAnswer')
          : info.media === 'video'
            ? t('call.outgoingVideo')
            : t('call.outgoingVoice')
      case 'incoming':
        // P4: an escalation invite rings as "邀请你加入…" instead of a plain
        // 1:1 来电 — the accept flow then lands in the multi-party form.
        if (info.kind === 'meet') {
          return info.media === 'video'
            ? t('call.incomingMeetVideo')
            : t('call.incomingMeetVoice')
        }
        return info.media === 'video'
          ? t('call.incomingVideo')
          : t('call.incomingVoice')
      case 'connecting':
        return t('call.connecting')
      case 'ended':
        return endReasonText(t, state.reason)
      default:
        return ''
    }
  })()

  return (
    <div className={overlayRoot} role="dialog" aria-label={statusText}>
      {state.phase === 'incoming' && <RingSound />}
      {state.phase === 'outgoing' && state.waitingAnswer && <RingbackSound />}
      <div className={centerCol}>
        <Avatar name={displayName} src={avatarUrl} size="7rem" />
        <div className={nameText}>{displayName}</div>
        <div className={statusLine}>{statusText}</div>
      </div>
      <div className={bottomRow}>
        {state.phase === 'outgoing' && (
          <RoundButton
            label={t('call.cancel')}
            color="#e5484d"
            onClick={cancelCall}
          >
            {/* Hang-up glyph (tilted receiver) — matches the App's cancel. */}
            <RiPhoneFill
              size={26}
              color="white"
              style={{ transform: 'rotate(135deg)' }}
            />
          </RoundButton>
        )}
        {state.phase === 'incoming' && (
          <>
            <RoundButton
              label={t('call.decline')}
              color="#e5484d"
              onClick={rejectCall}
            >
              <RiPhoneFill
                size={26}
                color="white"
                style={{ transform: 'rotate(135deg)' }}
              />
            </RoundButton>
            <RoundButton
              label={t('call.accept')}
              color="#30a46c"
              onClick={acceptCall}
            >
              {info.media === 'video' ? (
                <RiVidiconLine size={26} color="white" />
              ) : (
                <RiPhoneLine size={26} color="white" />
              )}
            </RoundButton>
          </>
        )}
      </div>
    </div>
  )
}

const RoundButton = ({
  label,
  color,
  onClick,
  children,
}: {
  label: string
  color: string
  onClick: () => void
  children: React.ReactNode
}) => (
  <div className={roundBtnCol}>
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={roundBtn}
      style={{ backgroundColor: color }}
    >
      {children}
    </button>
    <span className={roundBtnLabel}>{label}</span>
  </div>
)

/**
 * Looping ring-ring pattern via WebAudio while mounted (incoming only). No
 * asset dependency; browsers allow it because the page had prior interaction
 * in any realistic flow — when they don't, the visual overlay still rings.
 */
const RingSound = () => {
  useEffect(() => {
    let ctx: AudioContext | null = null
    let interval: ReturnType<typeof setInterval> | null = null
    try {
      ctx = new AudioContext()
      const ring = () => {
        if (!ctx || ctx.state === 'closed') return
        // Two short dual-tone bursts, classic telephone cadence.
        for (const offset of [0, 0.45]) {
          for (const freq of [440, 480]) {
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.frequency.value = freq
            gain.gain.setValueAtTime(0.08, ctx.currentTime + offset)
            gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset + 0.35)
            osc.connect(gain)
            gain.connect(ctx.destination)
            osc.start(ctx.currentTime + offset)
            osc.stop(ctx.currentTime + offset + 0.36)
          }
        }
      }
      ring()
      interval = setInterval(ring, 2_000)
    } catch {
      // Autoplay blocked — silent ring; the overlay is still visible.
    }
    return () => {
      if (interval) clearInterval(interval)
      void ctx?.close().catch(() => undefined)
    }
  }, [])
  return null
}

/**
 * Caller-side ringback while the callee's device is ringing — the Chinese
 * national tone: 450Hz, 1s on / 4s off, looping. Mirrors the App's
 * ToneGenerator ringback so both ends sound the same. Silent if autoplay is
 * blocked; the visual overlay still shows 等待接听.
 */
const RingbackSound = () => {
  useEffect(() => {
    let ctx: AudioContext | null = null
    let interval: ReturnType<typeof setInterval> | null = null
    try {
      ctx = new AudioContext()
      const beep = () => {
        if (!ctx || ctx.state === 'closed') return
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = 450
        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + 1.0)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 1.02)
      }
      beep()
      interval = setInterval(beep, 5_000) // 1s tone + 4s silence
    } catch {
      // Autoplay blocked — silent; the overlay still shows the state.
    }
    return () => {
      if (interval) clearInterval(interval)
      void ctx?.close().catch(() => undefined)
    }
  }, [])
  return null
}

const endReasonText = (
  t: (k: string) => string,
  reason: CallEndReason
): string => {
  switch (reason) {
    case 'declined':
      return t('call.endDeclined')
    case 'busy':
      return t('call.endBusy')
    case 'timeout':
      return t('call.endTimeout')
    case 'unreachable':
      return t('call.endUnreachable')
    case 'canceledRemote':
      return t('call.endCanceledRemote')
    case 'answeredElsewhere':
      return t('call.endAnsweredElsewhere')
    case 'declinedElsewhere':
      return t('call.endDeclinedElsewhere')
    case 'failed':
      return t('call.endFailed')
    // Locally-initiated endings show no lingering message; the overlay just
    // fades on the idle reset.
    case 'canceled':
    case 'declinedLocal':
      return ''
  }
}

const overlayRoot = css({
  position: 'fixed',
  inset: 0,
  zIndex: 2000,
  backgroundColor: 'greyscale.000',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingTop: '18vh',
  paddingBottom: '10vh',
})

const centerCol = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
})

const nameText = css({
  fontSize: '1.5rem',
  fontWeight: 600,
  color: 'greyscale.900',
  marginTop: '0.5rem',
})

const statusLine = css({
  fontSize: '1rem',
  color: 'greyscale.600',
  minHeight: '1.5rem',
})

const bottomRow = css({
  display: 'flex',
  gap: '5rem',
})

const roundBtnCol = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.5rem',
})

const roundBtn = css({
  width: '4rem',
  height: '4rem',
  borderRadius: '1.25rem',
  border: 'none',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 0.1s',
  _hover: { transform: 'scale(1.05)' },
})

const roundBtnLabel = css({
  fontSize: '0.875rem',
  color: 'greyscale.600',
})
