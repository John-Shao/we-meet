import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RoomEvent, Track, type Room, type RemoteTrack } from 'livekit-client'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import {
  ControllerSession,
  type ControllerSessionStatus,
} from '../../../../desktop/src/remote-control/controller-session'
import { Kind } from '../../../../desktop/src/remote-control/wire'
import { forbiddenChord, keyInput, shortcutKeys, videoPoint } from './input'
import { endReasonKey } from './presentation'

export function ControllerView({
  room,
  session,
  state,
  onClose,
  onRetry,
}: {
  room: Room
  session: ControllerSession
  state: ControllerSessionStatus
  onClose: () => void
  onRetry?: () => void
}) {
  const { t } = useTranslation('rooms', {
    keyPrefix: 'remoteControl.controller',
  })
  const { t: tStatus } = useTranslation('rooms', { keyPrefix: 'remoteControl' })
  const videoRef = useRef<HTMLVideoElement>(null),
    regionRef = useRef<HTMLDivElement>(null)
  const latest = useRef(state)
  latest.current = state
  const updateHealth = useRef<() => void>(() => undefined)
  const videoReady = useRef(false)
  const [ready, setReady] = useState(false),
    [draft, setDraft] = useState('')
  const [composing, setComposing] = useState(false),
    [error, setError] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const delivered = useRef(state.deliveredText)
  const pressed = useRef(new Set<string>()),
    buttons = useRef(new Set<number>())
  const inputGeneration = useRef(state.input?.inputGeneration)

  useEffect(() => {
    if (state.deliveredText !== delivered.current) {
      delivered.current = state.deliveredText
      setDraft('')
      setError(false)
    }
    if (
      state.input?.phase !== 'open' ||
      state.input.oneShot ||
      inputGeneration.current !== state.input.inputGeneration
    ) {
      pressed.current.clear()
      buttons.current.clear()
    }
    inputGeneration.current = state.input?.inputGeneration
  }, [
    state.deliveredText,
    state.input?.phase,
    state.input?.oneShot,
    state.input?.inputGeneration,
  ])

  useEffect(() => {
    const video = videoRef.current!,
      region = regionRef.current!
    let attached: RemoteTrack | undefined,
      frame = 0,
      lastFrame = -Infinity,
      stopped = false
    const sample = () => {
      const publication = room.remoteParticipants
        .get(state.target.identity)
        ?.trackPublications.get(state.trackSid ?? '')
      const dimensions = latest.current.input
      const ratioMatches =
        !dimensions?.width ||
        !dimensions.height ||
        !video.videoWidth ||
        Math.abs(
          video.videoWidth /
            video.videoHeight /
            (dimensions.width / dimensions.height) -
            1
        ) < 0.01
      const healthy =
        !!attached &&
        !!publication?.isSubscribed &&
        !publication.isMuted &&
        attached.mediaStreamTrack.readyState === 'live' &&
        !attached.mediaStreamTrack.muted &&
        video.readyState >= 2 &&
        !video.paused &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        performance.now() - lastFrame < 3000 &&
        ratioMatches
      videoReady.current = healthy
      setReady(healthy)
      const pageActive =
        document.visibilityState === 'visible' && document.hasFocus()
      session.setHealth({
        videoReady: healthy,
        pageActive,
        captureFocused: document.activeElement === region,
      })
    }
    updateHealth.current = sample
    const onFrame = () => {
      if (stopped) return
      lastFrame = performance.now()
      sample()
      frame = video.requestVideoFrameCallback(onFrame)
    }
    const update = () => {
      const peer = room.remoteParticipants.get(state.target.identity)
      if (!peer || peer.sid !== state.target.participantSid) {
        session.stop('connection_changed')
        return
      }
      const publication = peer.trackPublications.get(state.trackSid ?? '')
      if (publication && publication.source !== Track.Source.ScreenShare) {
        session.stop('screen_share_unavailable')
        return
      }
      publication?.setSubscribed(true)
      const track = publication?.track
      if (track !== attached) {
        if (attached && !track) {
          session.stop('screen_share_unavailable')
          return
        }
        attached?.detach(video)
        attached = track
        lastFrame = -Infinity
        if (attached) {
          attached.attach(video)
          void video.play().catch(() => {
            videoReady.current = false
            setReady(false)
            sample()
          })
        }
      }
      sample()
    }
    if (typeof video.requestVideoFrameCallback === 'function')
      frame = video.requestVideoFrameCallback(onFrame)
    // Without decoded-frame feedback this view remains view-only; no blind input.
    const timer = window.setInterval(sample, 250)
    room
      .on(RoomEvent.TrackPublished, update)
      .on(RoomEvent.TrackSubscribed, update)
      .on(RoomEvent.TrackUnpublished, update)
      .on(RoomEvent.TrackUnsubscribed, update)
      .on(RoomEvent.TrackMuted, update)
      .on(RoomEvent.TrackUnmuted, update)
    window.addEventListener('blur', sample)
    window.addEventListener('focus', sample)
    document.addEventListener('visibilitychange', sample)
    update()
    return () => {
      stopped = true
      window.clearInterval(timer)
      if (frame) video.cancelVideoFrameCallback(frame)
      attached?.detach(video)
      room
        .off(RoomEvent.TrackPublished, update)
        .off(RoomEvent.TrackSubscribed, update)
        .off(RoomEvent.TrackUnpublished, update)
        .off(RoomEvent.TrackUnsubscribed, update)
        .off(RoomEvent.TrackMuted, update)
        .off(RoomEvent.TrackUnmuted, update)
      window.removeEventListener('blur', sample)
      window.removeEventListener('focus', sample)
      document.removeEventListener('visibilitychange', sample)
      session.setHealth({
        pageActive: false,
        captureFocused: false,
        videoReady: false,
      })
    }
  }, [
    room,
    session,
    state.target.identity,
    state.target.participantSid,
    state.trackSid,
  ])

  useEffect(() => {
    const region = regionRef.current!,
      video = videoRef.current!
    let pendingMove: { x: number; y: number; generation: string } | undefined
    const capturing = () =>
      latest.current.phase !== 'ended' &&
      latest.current.input?.phase === 'open' &&
      !latest.current.input.oneShot &&
      document.activeElement === region &&
      document.hasFocus() &&
      document.visibilityState === 'visible' &&
      videoReady.current
    const suspend = () => {
      pendingMove = undefined
      pressed.current.clear()
      buttons.current.clear()
      session.suspend()
    }
    const point = (event: MouseEvent) =>
      videoPoint(
        video.getBoundingClientRect(),
        video.videoWidth,
        video.videoHeight,
        event.clientX,
        event.clientY
      )
    const flush = () => {
      if (pendingMove) {
        const p = pendingMove
        pendingMove = undefined
        if (
          capturing() &&
          p.generation === latest.current.input?.inputGeneration
        )
          session.input({ kind: Kind.Move, x: p.x, y: p.y })
      }
    }
    const move = (event: PointerEvent) => {
      if (!capturing() || event.pointerType !== 'mouse') return
      const p = point(event)
      if (!p) {
        if (buttons.current.size) suspend()
        return
      }
      const generation = latest.current.input?.inputGeneration
      if (generation) pendingMove = { ...p, generation } // No move crosses a capture generation.
    }
    const button = (event: PointerEvent) => {
      if (!capturing() || event.pointerType !== 'mouse') return
      event.preventDefault()
      event.stopPropagation()
      flush()
      const p = point(event),
        code = [0, 2, 1][event.button]
      if (code === undefined) return
      if (!p) {
        if (buttons.current.size) suspend()
        return
      }
      const down = event.type === 'pointerdown'
      if (down === buttons.current.has(code)) return
      if (
        !session.input({ kind: Kind.Button, action: down ? 1 : 0, code, ...p })
      )
        return
      if (down) {
        buttons.current.add(code)
        try {
          region.setPointerCapture(event.pointerId)
        } catch {
          suspend()
        }
      } else buttons.current.delete(code)
    }
    const wheel = (event: WheelEvent) => {
      if (!capturing()) return
      event.preventDefault()
      event.stopPropagation()
      flush()
      const p = point(event)
      if (!p || !event.deltaY) return
      const multiplier =
        event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1
      const delta = Math.max(
        -1200,
        Math.min(1200, Math.round(-event.deltaY * multiplier))
      )
      if (delta) session.input({ kind: Kind.Wheel, delta, ...p })
    }
    const key = (event: KeyboardEvent) => {
      if (!capturing()) return
      event.preventDefault()
      event.stopPropagation()
      flush()
      if (
        event.isComposing ||
        event.key === 'Process' ||
        event.keyCode === 229
      ) {
        suspend()
        return
      }
      if (event.code === 'Escape') {
        suspend()
        return
      } // Local escape; remote Escape has its own explicit button.
      const down = event.type === 'keydown',
        input = keyInput(event.code, down, event.repeat)
      if (!input || event.metaKey) {
        suspend()
        return
      }
      if (!down && !pressed.current.has(event.code)) return
      if (down && pressed.current.has(event.code) && !event.repeat) return
      const candidate = new Set(pressed.current)
      if (down) candidate.add(event.code)
      else candidate.delete(event.code)
      if (forbiddenChord(candidate)) {
        session.stop('forbidden_shortcut')
        return
      }
      // Modifiers held before entering the view must be released and pressed
      // again. Otherwise Ctrl+C could become an unintended plain remote C.
      const tracked = (left: string, right: string) =>
        candidate.has(left) || candidate.has(right)
      if (
        down &&
        ((event.ctrlKey && !tracked('ControlLeft', 'ControlRight')) ||
          (event.altKey && !tracked('AltLeft', 'AltRight')) ||
          (event.shiftKey && !tracked('ShiftLeft', 'ShiftRight')))
      ) {
        suspend()
        return
      }
      if (session.input(input)) pressed.current = candidate
    }
    const cancel = () => {
      if (buttons.current.size) suspend()
    }
    const blur = () => {
      suspend()
      updateHealth.current()
    }
    const contextMenu = (event: Event) => event.preventDefault()
    region.addEventListener('pointermove', move)
    region.addEventListener('pointerdown', button)
    region.addEventListener('pointerup', button)
    region.addEventListener('pointercancel', cancel)
    region.addEventListener('lostpointercapture', cancel)
    region.addEventListener('wheel', wheel, { passive: false })
    region.addEventListener('contextmenu', contextMenu)
    region.addEventListener('keydown', key)
    region.addEventListener('keyup', key)
    region.addEventListener('compositionstart', suspend)
    const focus = () => updateHealth.current()
    region.addEventListener('blur', blur)
    region.addEventListener('focus', focus)
    const timer = window.setInterval(flush, 34)
    return () => {
      window.clearInterval(timer)
      suspend()
      region.removeEventListener('pointermove', move)
      region.removeEventListener('pointerdown', button)
      region.removeEventListener('pointerup', button)
      region.removeEventListener('pointercancel', cancel)
      region.removeEventListener('lostpointercapture', cancel)
      region.removeEventListener('wheel', wheel)
      region.removeEventListener('contextmenu', contextMenu)
      region.removeEventListener('keydown', key)
      region.removeEventListener('keyup', key)
      region.removeEventListener('compositionstart', suspend)
      region.removeEventListener('blur', blur)
      region.removeEventListener('focus', focus)
    }
  }, [session])

  const inputPhase = state.input?.phase
  const canStart =
    state.phase !== 'ended' &&
    ready &&
    (inputPhase === 'waiting' || inputPhase === 'suspended')
  const run = (action: () => void) => {
    setError(false)
    try {
      updateHealth.current()
      action()
    } catch {
      setError(true)
    }
  }
  const shortcuts: { label: string; codes: string[] }[] = [
    { label: 'Enter', codes: ['Enter'] },
    { label: 'Tab', codes: ['Tab'] },
    { label: 'Esc', codes: ['Escape'] },
    { label: 'Ctrl+A', codes: ['ControlLeft', 'KeyA'] },
    { label: 'Ctrl+C', codes: ['ControlLeft', 'KeyC'] },
    { label: 'Ctrl+V', codes: ['ControlLeft', 'KeyV'] },
    { label: 'Ctrl+Z', codes: ['ControlLeft', 'KeyZ'] },
  ]
  return createPortal(
    <section
      role="dialog"
      aria-label={t('title', { name: state.target.name })}
      style={{
        width: minimized ? '380px' : 'min(1200px, calc(100vw - 32px))',
        height:
          state.phase === 'ended'
            ? 'auto'
            : minimized
              ? '280px'
              : 'min(84vh, 1000px)',
      }}
      className={css({
        position: 'fixed',
        left: '16px',
        bottom: '88px',
        zIndex: 'modal',
        backgroundColor: 'surface.default',
        color: 'text.primary',
        borderRadius: 'modal',
        boxShadow: 'modal',
        maxWidth: 'calc(100vw - 32px)',
        overflow: 'hidden',
      })}
    >
      <div
        className={css({
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '16px',
          minHeight: 0,
        })}
      >
        <div
          className={css({
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px',
            alignItems: 'center',
          })}
        >
          <strong>{t('title', { name: state.target.name })}</strong>
          <Button
            variant="secondaryText"
            size="dense"
            onPress={() => {
              session.suspend()
              setMinimized(!minimized)
            }}
          >
            {t(minimized ? 'expand' : 'minimize')}
          </Button>
          <Button variant="secondary" size="dense" onPress={onClose}>
            {t(state.phase === 'ended' ? 'close' : 'stop')}
          </Button>
        </div>
        <p role="status">
          {t(
            `phase.${state.phase === 'ended' ? 'ended' : (inputPhase ?? state.phase)}`
          )}
        </p>
        {state.phase === 'ended' && (
          <div role="status">
            <p>{tStatus(`endReason.${endReasonKey(state.reason)}`)}</p>
            <p>{t('retryHint')}</p>
            {onRetry && <Button onPress={onRetry}>{t('retry')}</Button>}
          </div>
        )}
        <div
          ref={regionRef}
          hidden={state.phase === 'ended'}
          tabIndex={minimized ? -1 : 0}
          role="application"
          aria-label={t('screen')}
          aria-describedby="remote-control-help"
          className={css({
            position: 'relative',
            flex: 1,
            minHeight: '160px',
            backgroundColor: 'black',
            overflow: 'hidden',
            outline: '2px solid',
            outlineColor:
              inputPhase === 'open' ? 'brand.500' : 'border.default',
            touchAction: 'none',
          })}
        >
          {/* Screen capture has no audio in this element; room audio remains separate. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-hidden="true"
            className={css({
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
            })}
          />
        </div>
        <div hidden={minimized || state.phase === 'ended'}>
          <p id="remote-control-help">{t('help')}</p>
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
              alignItems: 'center',
            })}
          >
            <Button
              variant="primary"
              size="dense"
              isDisabled={!canStart}
              onPress={() =>
                run(() => {
                  regionRef.current?.focus()
                  updateHealth.current()
                  session.capture()
                })
              }
            >
              {t('start')}
            </Button>
            <Button
              variant="secondary"
              size="dense"
              isDisabled={inputPhase !== 'open'}
              onPress={() => session.suspend()}
            >
              {t('pause')}
            </Button>
            {!ready && state.phase !== 'ended' && (
              <span>{t('videoUnavailable')}</span>
            )}
            {shortcuts.map((shortcut) => (
              <Button
                key={shortcut.label}
                variant="secondary"
                size="dense"
                isDisabled={!canStart || composing}
                onPress={() =>
                  run(() => session.shortcut(shortcutKeys(shortcut.codes)))
                }
                aria-label={t('remoteKey', { key: shortcut.label })}
              >
                {shortcut.label}
              </Button>
            ))}
          </div>
          <label
            className={css({
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            })}
          >
            <span>{t('textLabel')}</span>
            <textarea
              value={draft}
              rows={2}
              maxLength={256}
              disabled={
                state.phase === 'ended' || state.textOutcome === 'pending'
              }
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onFocus={() => session.suspend()}
              className={css({
                border: '1px solid',
                borderColor: 'border.default',
                borderRadius: 'field',
                padding: '8px',
                backgroundColor: 'surface.default',
                color: 'text.primary',
                resize: 'vertical',
                maxHeight: '100px',
              })}
            />
          </label>
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            })}
          >
            <Button
              variant="primary"
              size="dense"
              isDisabled={
                !canStart || composing || !draft || state.input?.oneShot
              }
              onPress={() => run(() => session.text(draft))}
            >
              {t('sendText')}
            </Button>
            <span>
              {draft.length}/256 · {t('textHint')}
            </span>
          </div>
          {error && <p role="alert">{t('actionUnavailable')}</p>}
          {state.textOutcome === 'unconfirmed' && (
            <p role="alert">{t('textUnconfirmed')}</p>
          )}
        </div>
      </div>
    </section>,
    document.body
  )
}
