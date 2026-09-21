import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
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

const time = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export const UploadMediaPlayer = forwardRef<
  UploadMediaHandle | null,
  {
    recordId: string
    onPosition?: (milliseconds: number) => void
    onDuration?: (milliseconds: number | null) => void
  }
>(function UploadMediaPlayer({ recordId, onPosition, onDuration }, ref) {
  const { t } = useTranslation('capture')
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
    const bounded = Math.max(0, milliseconds)
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
    if (element.paused) void element.play().catch(() => setState('error'))
    else element.pause()
  }

  const jump = (delta: number) => {
    const element = audio.current
    if (!element) return
    seek(positionRef.current + delta)
  }

  const MediaElement = media?.media_type === 'video' ? 'video' : 'audio'
  return (
    <section
      aria-label={t('playback')}
      className={css({
        flexShrink: 0,
        backgroundColor: 'surface.default',
        borderTop: '1px solid token(colors.border.subtle)',
        paddingY: 'md',
        paddingX: 0,
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
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'md',
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <Button
              variant="tertiary"
              isDisabled={state === 'loading' || state === 'error'}
              onPress={() => jump(-15_000)}
            >
              {t('skipBack')}
            </Button>
            <Button
              variant="primary"
              isDisabled={state === 'loading' || state === 'error'}
              onPress={toggle}
            >
              {t(state === 'playing' ? 'pausePlayback' : 'play')}
            </Button>
            <Button
              variant="tertiary"
              isDisabled={state === 'loading' || state === 'error'}
              onPress={() => jump(15_000)}
            >
              {t('skipForward')}
            </Button>
            <span aria-live="off" className={css({ minWidth: '6rem' })}>
              {time(position / 1000)} / {time(duration)}
            </span>
            <label>
              {t('playbackRate')}{' '}
              <select
                aria-label={t('playbackRate')}
                value={rate}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setRate(value)
                  if (audio.current) audio.current.playbackRate = value
                }}
              >
                {[0.75, 1, 1.25, 1.5, 2].map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* The browser owns seeking over Range, so no custom scrubber is needed.
              `jsx-a11y/media-has-caption` 只认原生 <audio>/<video>,这里渲染的是
              自定义的 `MediaElement`,所以那条 eslint-disable 从未生效过(已删)。 */}
          <MediaElement
            ref={attachMedia}
            src={media.url}
            controls
            playsInline
            preload="metadata"
            className={css({
              width: '100%',
              marginTop: 'sm',
              maxHeight: '40vh',
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
        </>
      )}
    </section>
  )
})
