import { useEffect, useRef, useState } from 'react'
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

const time = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Mount with viewer/capture key. Only one small, verified audio blob is retained at a time. */
export function CaptureAudioPlayer({ captureId }: { captureId: string }) {
  const { t } = useTranslation('capture')
  const [playlist, setPlaylist] = useState<AudioPlaylist>()
  const [state, setState] = useState<
    'loading' | 'ready' | 'playing' | 'gap' | 'error'
  >('loading')
  const [position, setPosition] = useState(0)
  const [rate, setRate] = useState(1)
  const audio = useRef<HTMLAudioElement>(null)
  const current = useRef<number>()
  const activeRequest = useRef<AbortController>()
  const url = useRef<string>()
  const mounted = useRef(true)
  const playlistRef = useRef<AudioPlaylist>()
  const rateRef = useRef(1)
  const seeking = useRef<{ playing: boolean }>()

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

  const seek = (milliseconds: number, resume = true) => {
    setPosition(milliseconds)
    const target = locateAudio(playlistRef.current?.chunks ?? [], milliseconds)
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
  const endSeek = () => {
    seek(position, !!seeking.current?.playing)
    seeking.current = undefined
  }

  const chunks = playlist?.chunks ?? []
  const last = chunks.at(-1)
  const total = last ? last.start_ms + last.duration_ms : 0
  const next = chunks.findIndex((chunk) => chunk.start_ms >= position)
  return (
    <section
      aria-label={t('playback')}
      className={css({
        marginTop: '1.5rem',
        padding: '1.25rem',
        border: '1px solid',
        borderColor: 'greyscale.200',
        borderRadius: '0.75rem',
      })}
    >
      <h2>{t('playback')}</h2>
      <p>{t('playbackHint')}</p>
      {playlist?.manifest?.outcome === 'incomplete' && (
        <p role="note">{t('incomplete')}</p>
      )}
      {state === 'loading' && <p role="status">{t('audioLoading')}</p>}
      {state === 'error' && <p role="alert">{t('audioError')}</p>}
      {state === 'gap' && <p role="status">{t('audioGap')}</p>}
      {!!playlist && !total && <p>{t('audioEmpty')}</p>}
      {!!total && (
        <>
          <p aria-live="off">
            {time(position)} / {time(total)}
          </p>
          <input
            aria-label={t('audioPosition')}
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            step={1}
            value={Math.min(position, total - 1)}
            onChange={(event) => setPosition(Number(event.target.value))}
            onPointerDown={beginSeek}
            onPointerUp={endSeek}
            onPointerCancel={endSeek}
            onKeyDown={beginSeek}
            onKeyUp={endSeek}
            onBlur={() => {
              if (seeking.current) endSeek()
            }}
            className={css({ width: '100%' })}
          />
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginTop: '0.75rem',
              alignItems: 'center',
            })}
          >
            {state === 'playing' ? (
              <Button
                variant="secondary"
                onPress={() => {
                  clear()
                  setState('ready')
                }}
              >
                {t('pausePlayback')}
              </Button>
            ) : (
              <Button
                variant="primary"
                isDisabled={
                  state === 'loading' || state === 'error' || state === 'gap'
                }
                onPress={() => seek(position >= total ? 0 : position)}
              >
                {t('play')}
              </Button>
            )}
            {state === 'gap' && next >= 0 && (
              <Button variant="secondary" onPress={() => void play(next)}>
                {t('skipGap')}
              </Button>
            )}
            <label>
              {t('playbackRate')}{' '}
              <select
                aria-label={t('playbackRate')}
                value={rate}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setRate(value)
                  rateRef.current = value
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
        </>
      )}
      {state === 'error' && (
        <Button variant="secondary" onPress={() => void load()}>
          {t('reloadAudio')}
        </Button>
      )}
      {/* Custom controls above keep global source time and missing ranges visible. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Original audio has no transcript yet; do not fabricate captions. */}
      <audio
        ref={audio}
        preload="none"
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
}
