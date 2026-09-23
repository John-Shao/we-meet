import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiFullscreenLine,
  RiFullscreenExitLine,
} from '@remixicon/react'
import { RecordPlaybackControls } from './RecordPlaybackControls'
import { Button as PlayerButton } from '@/primitives/Button'
import { useTranslation } from 'react-i18next'

import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

/**
 * Playback for an imported file.
 *
 * An upload lands as one sealed object, so it is streamed whole and the browser's
 * own Range handling does the seeking. That is deliberately a different player
 * from the capture one: a live capture arrives incrementally and can have gaps,
 * so its playback is a verified chunk table behind a manifest. Reusing that here
 * would mean a manifest and chunk rows that exist only to re-serve a file the
 * object store already serves — and the reader would still be unable to seek
 * precisely.
 */

export type UploadMediaHandle = { seek: (milliseconds: number) => void }

type MediaRead = {
  url: string
  expires_in: number
  media_type: 'audio' | 'video'
  name: string
  size: number
  content_type: string
}

export const UploadMediaPlayer = forwardRef<
  UploadMediaHandle | null,
  {
    recordId: string
    onUserSeek?: (milliseconds: number) => void
    onPosition?: (milliseconds: number) => void
    onDuration?: (milliseconds: number | null) => void
  }
>(function UploadMediaPlayer(
  { recordId, onPosition, onDuration, onUserSeek },
  ref
) {
  const { t } = useTranslation('capture')
  const playerSurface = useRef<HTMLElement>(null)
  const [videoExpanded, setVideoExpanded] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenSupported, setFullscreenSupported] = useState(false)
  const [fullscreenError, setFullscreenError] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideControls = useRef<ReturnType<typeof setTimeout>>()
  const scrubbing = useRef<boolean>()
  useEffect(() => {
    setFullscreenSupported(
      typeof document.documentElement.requestFullscreen === 'function'
    )
    const changed = () =>
      setFullscreen(document.fullscreenElement === playerSurface.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  const toggleFullscreen = async () => {
    setFullscreenError(false)
    try {
      if (document.fullscreenElement === playerSurface.current)
        await document.exitFullscreen()
      else {
        setVideoExpanded(true)
        await playerSurface.current?.requestFullscreen()
      }
    } catch {
      setFullscreenError(true)
    }
  }
  const [media, setMedia] = useState<MediaRead>()
  const [state, setState] = useState<'loading' | 'ready' | 'playing' | 'error'>(
    'loading'
  )
  const revealControls = () => {
    setControlsVisible(true)
    clearTimeout(hideControls.current)
    if (state === 'playing')
      hideControls.current = setTimeout(() => setControlsVisible(false), 2500)
  }
  useEffect(() => {
    setControlsVisible(true)
    if (state === 'playing' && videoExpanded)
      hideControls.current = setTimeout(() => setControlsVisible(false), 2500)
    return () => clearTimeout(hideControls.current)
  }, [state, videoExpanded])
  const [position, setPositionState] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const audio = useRef<HTMLMediaElement | null>(null)
  const positionRef = useRef(0)
  const playingRef = useRef(false)
  const pending = useRef<{ seconds: number; resume: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const attachMedia = useCallback((element: HTMLMediaElement | null) => {
    if (!element) audio.current?.pause()
    audio.current = element
  }, [])
  const mounted = useRef(true)
  const onDurationRef = useRef(onDuration)
  onDurationRef.current = onDuration
  useEffect(() => {
    onDurationRef.current?.(null)
    return () => onDurationRef.current?.(null)
  }, [recordId])
  const onPositionRef = useRef(onPosition)
  onPositionRef.current = onPosition

  /** Single writer for the source clock, so a follower cannot miss a change. */
  const setPosition = (milliseconds: number) => {
    positionRef.current = milliseconds
    setPositionState(milliseconds)
    if (scrubbing.current === undefined) onPositionRef.current?.(milliseconds)
  }

  // Read the real media clock, including stalls/rate changes. Background tabs
  // suspend RAF; foreground resumes from currentTime, never an elapsed counter.
  useEffect(() => {
    if (state !== 'playing') return
    let frame = 0,
      last = 0
    const sample = (now: number) => {
      const element = audio.current
      if (
        now - last >= 50 &&
        element &&
        !element.seeking &&
        !pending.current &&
        scrubbing.current === undefined
      ) {
        last = now
        const ms = element.currentTime * 1000
        if (Number.isFinite(ms) && ms !== positionRef.current) {
          positionRef.current = ms
          setPositionState(ms)
          onPositionRef.current?.(ms)
        }
      }
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frame)
  }, [state, recordId])

  useEffect(() => {
    mounted.current = true
    const request = new AbortController()
    setState('loading')
    let timer: ReturnType<typeof setTimeout> | undefined
    const resolve = async () => {
      try {
        const data = await fetchApi<MediaRead>(
          `meeting-records/${recordId}/media/`,
          { signal: request.signal, cache: 'no-store' }
        )
        if (request.signal.aborted || !mounted.current) return
        const element = audio.current
        if (element && element.getAttribute('src') !== data.url) {
          pending.current ??= {
            seconds: positionRef.current / 1000,
            resume: playingRef.current,
          }
        }
        setMedia(data)
        if (retry && element?.getAttribute('src') === data.url) element.load()
        setState(playingRef.current ? 'playing' : 'ready')
        // Refresh the lease before a later Range request can use an expired URL.
        timer = setTimeout(
          () => void resolve(),
          Math.max(1000, Math.min(86400000, data.expires_in * 800))
        )
      } catch {
        if (!request.signal.aborted && mounted.current) {
          playingRef.current = false
          audio.current?.pause()
          setMedia(undefined)
          setState('error')
        }
      }
    }
    void resolve()
    return () => {
      mounted.current = false
      request.abort()
      clearTimeout(timer)
    }
  }, [recordId, retry])

  const seek = (milliseconds: number) => {
    if (!Number.isFinite(milliseconds)) return
    const bounded = Math.max(
      0,
      duration > 0 ? Math.min(duration * 1000, milliseconds) : milliseconds
    )
    const element = audio.current
    if (element) {
      try {
        element.currentTime = bounded / 1000
      } catch {
        /* Apply after metadata. */
      }
    }
    if (!element || element.readyState === 0 || pending.current) {
      pending.current = {
        seconds: bounded / 1000,
        resume: pending.current?.resume ?? playingRef.current,
      }
    }
    setPosition(bounded)
    if (scrubbing.current === undefined) onUserSeek?.(bounded)
  }
  useImperativeHandle(ref, () => ({ seek }))

  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (playingRef.current) element.pause()
    else {
      if (duration > 0 && positionRef.current >= duration * 1000) seek(0)
      void element.play().catch(() => setState('error'))
    }
  }

  const jump = (delta: number) => {
    const element = audio.current
    if (!element) return
    seek(positionRef.current + delta)
  }

  const beginSeek = () => {
    if (scrubbing.current !== undefined) return
    scrubbing.current = playingRef.current
    audio.current?.pause()
  }
  const endSeek = () => {
    const resume = scrubbing.current
    scrubbing.current = undefined
    const ms = (audio.current?.currentTime ?? positionRef.current / 1000) * 1000
    onPositionRef.current?.(ms)
    onUserSeek?.(ms)
    if (resume) void audio.current?.play().catch(() => setState('error'))
  }
  const MediaElement = media?.media_type === 'video' ? 'video' : 'audio'
  const videoSurface = media?.media_type === 'video' && videoExpanded
  return (
    <section
      ref={playerSurface}
      data-video-expanded={videoSurface}
      data-controls-visible={controlsVisible || state !== 'playing'}
      data-theme={videoSurface ? 'dark' : undefined}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onFocusCapture={revealControls}
      aria-label={t('playback')}
      className={css({
        flexShrink: 0,
        backgroundColor: 'surface.default',
        borderTop: '1px solid token(colors.border.subtle)',
        paddingY: 'sm',
        paddingX: 'lg',
        position: 'relative',
        '&[data-video-expanded=true]': {
          padding: 0,
          border: 0,
          backgroundColor: 'black',
          color: 'white',
          aspectRatio: '16 / 9',
          minHeight: '15rem',
          alignSelf: 'stretch',
          '& video': { position: 'absolute', inset: 0, height: '100%' },
          '& [data-video-chrome]': { transition: 'opacity 160ms ease' },
          '& [data-video-header]': {
            position: 'absolute',
            top: 'sm',
            left: 'lg',
            right: 'lg',
            zIndex: 2,
            margin: 0,
          },
          '& [data-video-controls]': {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 'lg',
            paddingTop: 'xl',
            background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.85))',
            '& button:not([data-disabled]), & [data-playback-time], & [data-playback-time] span':
              { color: 'white' },
            '& select': {
              backgroundColor: 'transparent !important',
              color: 'white !important',
            },
          },
          '& [data-video-header] button': {
            color: 'white',
            backgroundColor: 'black/40',
          },
          '& [role=status], & [role=alert]': {
            position: 'relative',
            zIndex: 3,
          },
        },
        '&[data-video-expanded=true][data-controls-visible=false] [data-video-chrome]':
          { opacity: 0, pointerEvents: 'none' },
        '&:has(:focus-visible) [data-video-chrome]': {
          opacity: 1,
          pointerEvents: 'auto',
        },
        '@media (prefers-reduced-motion: reduce)': {
          '& [data-video-chrome]': { transition: 'none' },
        },
        '&:fullscreen': {
          width: '100%',
          height: '100%',
          maxHeight: 'none',
          padding: 0,
          borderRadius: 'none',
        },
      })}
    >
      {state === 'loading' && (
        <p role="status" className={css({ paddingY: 0, paddingX: 'lg' })}>
          {t('audioLoading')}
        </p>
      )}
      {state === 'error' && (
        <div>
          <p role="alert" className={css({ paddingY: 0, paddingX: 'lg' })}>
            {t('audioError')}
          </p>
          <Button
            variant="tertiary"
            onPress={() => {
              pending.current = {
                seconds: positionRef.current / 1000,
                resume: false,
              }
              setRetry((value) => value + 1)
            }}
          >
            {t('asr.refresh')}
          </Button>
        </div>
      )}
      {media && (
        <>
          {media.media_type === 'video' && (
            <div
              data-video-header
              data-video-chrome
              className={css({
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 'sm',
                marginBottom: 'sm',
              })}
            >
              <PlayerButton
                variant="quaternaryText"
                size="dense"
                aria-expanded={videoExpanded}
                onPress={() => setVideoExpanded((value) => !value)}
                isDisabled={fullscreen}
              >
                {videoExpanded ? (
                  <RiArrowDownSLine size={18} aria-hidden />
                ) : (
                  <RiArrowUpSLine size={18} aria-hidden />
                )}
                {t(videoExpanded ? 'hideVideo' : 'showVideo')}
              </PlayerButton>
              <PlayerButton
                variant="quaternaryText"
                size="xs"
                className={css({
                  minWidth: '2.75rem',
                  minHeight: '2.75rem',
                })}
                onPress={() => void toggleFullscreen()}
                aria-label={t(fullscreen ? 'exitFullscreen' : 'fullscreen')}
                tooltip={t(fullscreen ? 'exitFullscreen' : 'fullscreen')}
                isDisabled={!fullscreenSupported}
              >
                {fullscreen ? (
                  <RiFullscreenExitLine size={20} aria-hidden />
                ) : (
                  <RiFullscreenLine size={20} aria-hidden />
                )}
              </PlayerButton>
            </div>
          )}
          {fullscreenError && <p role="status">{t('fullscreenError')}</p>}
          {/* Keep one media element mounted: pause, collapse and full screen preserve its frame and stream. */}
          <MediaElement
            ref={attachMedia}
            src={media.url}
            controls={false}
            hidden={media.media_type !== 'video' || !videoExpanded}
            playsInline
            preload="metadata"
            className={css({
              width: '100%',
              display: 'block',
              '&[hidden]': { display: 'none' },
              objectFit: 'contain',
            })}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget
              onDurationRef.current?.(
                Number.isFinite(element.duration) && element.duration > 0
                  ? Math.round(element.duration * 1000)
                  : null
              )
              element.playbackRate = rate
              element.volume = volume
              element.muted = muted
              const restore = pending.current
              pending.current = null
              if (restore) {
                const seconds = Number.isFinite(element.duration)
                  ? Math.min(restore.seconds, element.duration)
                  : restore.seconds
                element.currentTime = seconds
                setPosition(seconds * 1000)
                if (restore.resume)
                  void element.play().catch(() => {
                    if (mounted.current) setState('error')
                  })
              }
              setDuration(
                Number.isFinite(element.duration) ? element.duration : 0
              )
            }}
            onDurationChange={(event) => {
              const value = event.currentTarget.duration
              setDuration(Number.isFinite(value) ? value : 0)
              onDurationRef.current?.(
                Number.isFinite(value) && value > 0
                  ? Math.round(value * 1000)
                  : null
              )
            }}
            onVolumeChange={(event) => {
              setVolume(event.currentTarget.volume)
              setMuted(event.currentTarget.muted)
            }}
            onTimeUpdate={(event) => {
              if (!pending.current)
                setPosition(event.currentTarget.currentTime * 1000)
            }}
            onPlay={() => {
              playingRef.current = true
              setState('playing')
            }}
            onPause={() => {
              if (!pending.current) {
                playingRef.current = false
                setState('ready')
              }
            }}
            onEnded={() => {
              playingRef.current = false
              setState('ready')
            }}
            onError={() => {
              playingRef.current = false
              setState('error')
            }}
          />
          <div data-video-controls data-video-chrome>
            <RecordPlaybackControls
              position={position}
              duration={duration * 1000}
              playing={state === 'playing'}
              rate={rate}
              volume={volume}
              muted={muted}
              onVolume={(value) => {
                setVolume(value)
                setMuted(false)
                if (audio.current) {
                  audio.current.volume = value
                  audio.current.muted = false
                }
              }}
              onToggleMute={() => {
                const nextMuted = !(muted || volume === 0)
                setMuted(nextMuted)
                if (audio.current) audio.current.muted = nextMuted
                if (!nextMuted && volume === 0) {
                  setVolume(1)
                  if (audio.current) audio.current.volume = 1
                }
              }}
              disabled={state === 'loading' || state === 'error'}
              onPlayPause={toggle}
              onSeek={seek}
              onBack={() => jump(-15000)}
              onForward={() => jump(15000)}
              onRate={(value) => {
                setRate(value)
                if (audio.current) audio.current.playbackRate = value
              }}
              seekEvents={{
                onPointerDown: beginSeek,
                onPointerUp: endSeek,
                onPointerCancel: endSeek,
                onKeyDown: (event) => {
                  if (
                    [
                      'ArrowLeft',
                      'ArrowRight',
                      'ArrowUp',
                      'ArrowDown',
                      'Home',
                      'End',
                      'PageUp',
                      'PageDown',
                    ].includes(event.key)
                  )
                    beginSeek()
                },
                onKeyUp: endSeek,
                onBlur: endSeek,
              }}
            />
          </div>
        </>
      )}
    </section>
  )
})
