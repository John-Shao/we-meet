import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import {
  audioChunk,
  audioPlaylist,
  checkAudioAccess,
  locateAudio,
  type AudioPlaylist,
} from '../capture/playback'

import { RecordPlaybackControls } from './RecordPlaybackControls'

/** Mount with viewer/capture key. Only one small, verified audio blob is retained at a time. */
export type CaptureAudioHandle = { seek: (milliseconds: number) => void }
export const CaptureAudioPlayer = forwardRef<
  CaptureAudioHandle,
  {
    captureId: string
    compact?: boolean
    onUserSeek?: (milliseconds: number) => void
    /**
     * Report the source-clock position so a transcript can follow playback.
     * Fires on seeks and on every time update while playing.
     */
    onPosition?: (milliseconds: number) => void
  }
>(function CaptureAudioPlayer(
  { captureId, compact = false, onPosition, onUserSeek },
  ref
) {
  const { t } = useTranslation('capture')
  const [playlist, setPlaylist] = useState<AudioPlaylist>()
  const [state, setState] = useState<
    'loading' | 'ready' | 'playing' | 'gap' | 'error'
  >('loading')
  const [position, setPositionState] = useState(0)
  const [rate, setRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  const current = useRef<number>()
  const activeRequest = useRef<AbortController>()
  const url = useRef<string>()
  const mounted = useRef(true)
  const playlistRef = useRef<AudioPlaylist>()
  const rateRef = useRef(1)
  const positionRef = useRef(0)
  const seeking = useRef<{ playing: boolean }>()
  // Kept in a ref so a new callback identity never re-runs the load effects.
  const onPositionRef = useRef(onPosition)
  onPositionRef.current = onPosition

  /** Single writer for the source clock, so a follower cannot miss a change. */
  const setPosition = (milliseconds: number) => {
    positionRef.current = milliseconds
    setPositionState(milliseconds)
    onPositionRef.current?.(milliseconds)
  }

  const clear = () => {
    activeRequest.current?.abort()
    audio.current?.pause()
    if (audio.current) {
      audio.current.removeAttribute('src')
      audio.current.load()
    }
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = undefined
    current.current = undefined
  }

  const load = async () => {
    clear()
    setPlaylist(undefined)
    playlistRef.current = undefined
    setState('loading')
    const request = new AbortController()
    activeRequest.current = request
    try {
      const data = await audioPlaylist(captureId, request.signal)
      if (request.signal.aborted || !mounted.current) return
      playlistRef.current = data
      setPlaylist(data)
      setPosition(0)
      setState('ready')
    } catch {
      if (!request.signal.aborted && mounted.current) setState('error')
    }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      clear()
    }
    // The parent remounts this component for every viewer/capture identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId])

  const play = async (index: number, offset = 0) => {
    clear()
    const chunk = playlistRef.current?.chunks[index]
    if (!chunk) return
    setState('loading')
    const request = new AbortController()
    activeRequest.current = request
    try {
      const blob = await audioChunk(captureId, chunk, request.signal)
      if (request.signal.aborted || !mounted.current || !audio.current) return
      url.current = URL.createObjectURL(blob)
      current.current = index
      audio.current.src = url.current
      audio.current.currentTime = offset
      audio.current.playbackRate = rateRef.current
      await audio.current.play()
      if (!request.signal.aborted && mounted.current) setState('playing')
    } catch {
      if (!request.signal.aborted && mounted.current) {
        clear()
        setState('error')
      }
    }
  }

  // Revalidate permission while playing. A failed/revoked read clears cached audio.
  useEffect(() => {
    if (state !== 'playing') return
    const check = new AbortController()
    let pending = false
    const interval = window.setInterval(() => {
      if (pending) return
      pending = true
      void checkAudioAccess(captureId, check.signal)
        .catch(() => {
          if (!check.signal.aborted) {
            clear()
            setPlaylist(undefined)
            playlistRef.current = undefined
            setPosition(0)
            setState('error')
          }
        })
        .finally(() => {
          pending = false
        })
    }, 5000)
    return () => {
      clearInterval(interval)
      check.abort()
    }
  }, [captureId, state])

  const seek = (milliseconds: number, resume = true, userInitiated = true) => {
    if (!Number.isFinite(milliseconds)) return
    const entries = playlistRef.current?.chunks ?? []
    const last = entries.at(-1)
    const end = last ? last.start_ms + last.duration_ms : 0
    const bounded = Math.max(0, Math.min(milliseconds, end))
    setPosition(bounded)
    if (userInitiated) onUserSeek?.(bounded)
    if (end > 0 && bounded === end) {
      clear()
      setState('ready')
      return
    }
    const target = locateAudio(entries, bounded)
    if (!target) {
      clear()
      setState('gap')
    } else if (resume) void play(target.index, target.offset)
    else {
      clear()
      setState('ready')
    }
  }

  const beginSeek = () => {
    if (seeking.current) return
    seeking.current = { playing: state === 'playing' }
    clear()
    setState('ready')
  }
  useImperativeHandle(ref, () => ({
    seek: (milliseconds) => seek(milliseconds),
  }))
  const endSeek = () => {
    if (!seeking.current) return
    seek(positionRef.current, !!seeking.current?.playing)
    seeking.current = undefined
  }

  const chunks = playlist?.chunks ?? []
  const last = chunks.at(-1)
  const total = last ? last.start_ms + last.duration_ms : 0
  const next = chunks.findIndex((chunk) => chunk.start_ms >= position)
  return (
    <section
      data-compact={compact}
      aria-label={t('playback')}
      className={css({
        marginTop: 'xl',
        padding: '1.25rem',
        border: '1px solid',
        borderColor: 'border.subtle',
        borderRadius: 'card',
        '&[data-compact=true]': {
          marginTop: 0,
          paddingY: 'sm',
          paddingX: 'lg',
          border: 'none',
          borderRadius: 'none',
        },
      })}
    >
      {!compact && (
        <>
          <h2>{t('playback')}</h2>
          <p>{t('playbackHint')}</p>
        </>
      )}
      {playlist?.manifest?.outcome === 'incomplete' && (
        <p role="note">{t('incomplete')}</p>
      )}
      {state === 'loading' && <p role="status">{t('audioLoading')}</p>}
      {state === 'error' && <p role="alert">{t('audioError')}</p>}
      {state === 'gap' && <p role="status">{t('audioGap')}</p>}
      {!!playlist && !total && <p>{t('audioEmpty')}</p>}
      {!!total && (
        <>
          <RecordPlaybackControls
            position={position}
            duration={total}
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
            playDisabled={
              state === 'loading' || state === 'error' || state === 'gap'
            }
            onSeek={setPosition}
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
              onKeyUp: () => {
                if (seeking.current) endSeek()
              },
              onBlur: () => {
                if (seeking.current) endSeek()
              },
            }}
            onPlayPause={() => {
              if (state === 'playing') {
                clear()
                setState('ready')
              } else
                seek(position >= total ? 0 : position, true, position >= total)
            }}
            onBack={() => seek(Math.max(0, position - 15000))}
            onForward={() => seek(Math.min(total - 1, position + 15000))}
            onRate={(value) => {
              setRate(value)
              rateRef.current = value
              if (audio.current) audio.current.playbackRate = value
            }}
          />
          {state === 'gap' && next >= 0 && (
            <Button
              variant="secondary"
              onPress={() => seek(chunks[next].start_ms)}
            >
              {t('skipGap')}
            </Button>
          )}
        </>
      )}
      {state === 'error' && (
        <Button variant="secondary" onPress={() => void load()}>
          {t('reloadAudio')}
        </Button>
      )}
      {/* Custom controls above keep global source time and missing ranges visible. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Optional ASR text is a separate source-linked panel; some audio has no transcript. */}
      <audio
        ref={audio}
        preload="none"
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume)
          setMuted(event.currentTarget.muted)
        }}
        onTimeUpdate={() => {
          const chunk = chunks[current.current ?? -1]
          if (chunk && audio.current)
            setPosition(chunk.start_ms + audio.current.currentTime * 1000)
        }}
        onError={() => {
          if (url.current) {
            clear()
            setState('error')
          }
        }}
        onEnded={() => {
          const index = current.current
          if (index === undefined) return
          const chunk = chunks[index]
          const end = chunk.start_ms + chunk.duration_ms
          setPosition(end)
          const following = chunks[index + 1]
          if (!following) {
            clear()
            setState('ready')
            return
          }
          if (
            following.sequence !== chunk.sequence + 1 ||
            following.start_ms !== end
          ) {
            clear()
            setState('gap')
            return
          }
          void play(index + 1)
        }}
      />
    </section>
  )
})
