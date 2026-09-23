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
import {
  RecordPlaybackControls,
  type PlaybackFollowControl,
} from './RecordPlaybackControls'
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
    followControl?: PlaybackFollowControl
    onPosition?: (milliseconds: number) => void
    onDuration?: (milliseconds: number | null) => void
  }
>(function UploadMediaPlayer(
  { recordId, onPosition, onDuration, followControl },
  ref
) {
  const { t } = useTranslation('capture')
  const playerSurface = useRef<HTMLElement>(null)
  const [videoExpanded, setVideoExpanded] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenSupported, setFullscreenSupported] = useState(false)
  const [fullscreenError, setFullscreenError] = useState(false)
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
  const [position, setPositionState] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
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
    onPositionRef.current?.(milliseconds)
  }

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
    if (resume) void audio.current?.play().catch(() => setState('error'))
  }
  const MediaElement = media?.media_type === 'video' ? 'video' : 'audio'
  return (
    <section
      ref={playerSurface}
      aria-label={t('playback')}
      className={css({
        flexShrink: 0,
        backgroundColor: 'surface.default',
        borderTop: '1px solid token(colors.border.subtle)',
        paddingY: 'sm',
        paddingX: 'lg',
        borderTopLeftRadius: 'card',
        borderTopRightRadius: 'card',
        '&:fullscreen': {
          display: 'flex',
          flexDirection: 'column',
          gap: 'sm',
          padding: 'lg',
          overflowY: 'auto',
          borderRadius: 'none',
          '& video': {
            flex: 1,
            minHeight: 0,
            maxHeight: 'calc(100dvh - 12rem)',
          },
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
                size="dense"
                onPress={() => void toggleFullscreen()}
                aria-label={t(fullscreen ? 'exitFullscreen' : 'fullscreen')}
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
              marginBottom: 'sm',
              borderRadius: 'control',
              maxHeight: '30vh',
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
          <RecordPlaybackControls
            position={position}
            duration={duration * 1000}
            playing={state === 'playing'}
            rate={rate}
            disabled={state === 'loading' || state === 'error'}
            onPlayPause={toggle}
            onSeek={seek}
            onBack={() => jump(-15000)}
            onForward={() => jump(15000)}
            onRate={(value) => {
              setRate(value)
              if (audio.current) audio.current.playbackRate = value
            }}
            followControl={fullscreen ? undefined : followControl}
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
        </>
      )}
    </section>
  )
})
