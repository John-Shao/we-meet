import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
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
  }
>(function UploadMediaPlayer({ recordId, onPosition }, ref) {
  const { t } = useTranslation('capture')
  const [media, setMedia] = useState<MediaRead>()
  const [state, setState] = useState<'loading' | 'ready' | 'playing' | 'error'>(
    'loading'
  )
  const [position, setPositionState] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const audio = useRef<HTMLAudioElement>(null)
  const mounted = useRef(true)
  const onPositionRef = useRef(onPosition)
  onPositionRef.current = onPosition

  /** Single writer for the source clock, so a follower cannot miss a change. */
  const setPosition = (milliseconds: number) => {
    setPositionState(milliseconds)
    onPositionRef.current?.(milliseconds)
  }

  useEffect(() => {
    mounted.current = true
    const request = new AbortController()
    setState('loading')
    void (async () => {
      try {
        // The URL is short-lived, so it is resolved per mount and never cached.
        const data = await fetchApi<MediaRead>(
          `meeting-records/${recordId}/media/`,
          { signal: request.signal, cache: 'no-store' }
        )
        if (request.signal.aborted || !mounted.current) return
        setMedia(data)
        setState('ready')
      } catch {
        if (!request.signal.aborted && mounted.current) setState('error')
      }
    })()
    return () => {
      mounted.current = false
      request.abort()
    }
  }, [recordId])

  useImperativeHandle(ref, () => ({
    seek: (milliseconds: number) => {
      const element = audio.current
      if (!element) return
      element.currentTime = Math.max(0, milliseconds / 1000)
      setPosition(milliseconds)
    },
  }))

  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setState('error'))
    else element.pause()
  }

  const jump = (delta: number) => {
    const element = audio.current
    if (!element) return
    element.currentTime = Math.max(0, element.currentTime + delta / 1000)
  }

  return (
    <section
      aria-label={t('playback')}
      className={css({
        flexShrink: 0,
        backgroundColor: 'surface.default',
        borderTop: '1px solid token(colors.border.subtle)',
        padding: '0.75rem 0',
      })}
    >
      {state === 'loading' && (
        <p role="status" className={css({ padding: '0 1rem' })}>
          {t('audioLoading')}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className={css({ padding: '0 1rem' })}>
          {t('audioError')}
        </p>
      )}
      {media && (
        <>
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
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
          {/* The browser owns seeking over Range, so no custom scrubber is needed. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the transcript is a separate synced panel; an imported file may have no captions at all. */}
          <audio
            ref={audio}
            src={media.url}
            controls
            preload="metadata"
            className={css({ width: '100%', marginTop: '0.5rem' })}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget
              element.playbackRate = rate
              setDuration(Number.isFinite(element.duration) ? element.duration : 0)
            }}
            onTimeUpdate={(event) =>
              setPosition(event.currentTarget.currentTime * 1000)
            }
            onPlay={() => setState('playing')}
            onPause={() => setState('ready')}
            onEnded={() => setState('ready')}
            onError={() => setState('error')}
          />
        </>
      )}
    </section>
  )
})
