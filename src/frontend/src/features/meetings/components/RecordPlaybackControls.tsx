import {
  RiPauseFill,
  RiPlayFill,
  RiVolumeUpLine,
  RiVolumeMuteLine,
} from '@remixicon/react'
import type { CSSProperties, InputHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives/Button'
import { css, cx } from '@/styled-system/css'

const playbackTime = (milliseconds: number) => {
  const seconds = Math.floor(
    Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000
  )
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const action = css({
  minWidth: '2.75rem',
  minHeight: '2.75rem',
  padding: 'xs',
  borderRadius: 'pill',
  justifySelf: 'center',
  textStyle: 'labelMedium',
})

export function PlaybackTime({
  position,
  duration,
}: {
  position: number
  duration: number
}) {
  return (
    <div
      data-playback-time
      aria-live="off"
      className={css({
        gridArea: 'time',
        whiteSpace: 'nowrap',
        textStyle: 'titleSmall',
        color: 'text.primary',
        fontVariantNumeric: 'tabular-nums',
        paddingX: 'sm',
      })}
    >
      {playbackTime(position)}{' '}
      <span className={css({ color: 'text.secondary' })}>
        /{' '}
        {Number.isFinite(duration) && duration > 0
          ? playbackTime(duration)
          : '—'}
      </span>
    </div>
  )
}

/** Full-width timeline above a compact transport row; wraps inside narrow panes. */
export function RecordPlaybackControls({
  position,
  duration,
  playing,
  rate,
  volume,
  muted,
  onVolume,
  onToggleMute,
  disabled = false,
  playDisabled = disabled,
  onPlayPause,
  onSeek,
  onRate,
  onBack,
  onForward,
  seekEvents,
}: {
  position: number
  duration: number
  playing: boolean
  rate: number
  volume: number
  muted: boolean
  onVolume: (volume: number) => void
  onToggleMute: () => void
  disabled?: boolean
  playDisabled?: boolean
  onPlayPause: () => void
  onSeek: (milliseconds: number) => void
  onRate: (rate: number) => void
  onBack: () => void
  onForward: () => void
  seekEvents?: Pick<
    InputHTMLAttributes<HTMLInputElement>,
    | 'onPointerDown'
    | 'onPointerUp'
    | 'onPointerCancel'
    | 'onKeyDown'
    | 'onKeyUp'
    | 'onBlur'
  >
}) {
  const { t } = useTranslation('capture')
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0
  const progress = end ? Math.min(100, Math.max(0, (position / end) * 100)) : 0
  return (
    <div
      data-record-playback-controls
      className={css({ width: '100%', containerType: 'inline-size' })}
    >
      <input
        type="range"
        aria-label={t('audioPosition')}
        aria-valuetext={`${playbackTime(position)} / ${end ? playbackTime(end) : '—'}`}
        min={0}
        max={end || 1}
        step={1}
        value={Math.max(0, Math.min(position, end))}
        disabled={disabled || !end}
        onChange={(event) => onSeek(Number(event.target.value))}
        {...seekEvents}
        style={{ '--playback-progress': `${progress}%` } as CSSProperties}
        className={css({
          appearance: 'none',
          display: 'block',
          width: '100%',
          height: '1.75rem',
          '@media (pointer: coarse)': { height: '2.75rem' },
          margin: 0,
          cursor: 'pointer',
          background: 'transparent',
          borderRadius: 'field',
          _focusVisible: {
            outline: '2px solid token(colors.border.focus)',
            outlineOffset: '2px',
          },
          _disabled: { opacity: 0.5, cursor: 'default' },
          '&::-webkit-slider-runnable-track': {
            height: '0.25rem',
            borderRadius: 'pill',
            background:
              'linear-gradient(to right, token(colors.action.primary.bg) var(--playback-progress), token(colors.action.selected.bg) var(--playback-progress))',
          },
          '&::-webkit-slider-thumb': {
            appearance: 'none',
            width: '0.75rem',
            height: '0.75rem',
            marginTop: '-0.25rem',
            borderRadius: 'pill',
            backgroundColor: 'action.primary.bg',
            border: 0,
          },
          '&::-moz-range-track': {
            height: '0.25rem',
            borderRadius: 'pill',
            backgroundColor: 'action.selected.bg',
          },
          '&::-moz-range-progress': {
            height: '0.25rem',
            borderRadius: 'pill',
            backgroundColor: 'action.primary.bg',
          },
          '&::-moz-range-thumb': {
            width: '0.75rem',
            height: '0.75rem',
            borderRadius: 'pill',
            border: 0,
            backgroundColor: 'action.primary.bg',
          },
        })}
      />
      <div
        className={css({
          display: 'grid',
          gridTemplateAreas:
            '"play back forward volume" "speed time time time"',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          alignItems: 'center',
          columnGap: 'xs',
          '@container (min-width: 560px)': {
            gridTemplateAreas: '"play back forward volume spacer speed time"',
            gridTemplateColumns:
              '2.75rem 2.75rem 2.75rem 2.75rem 1fr 3.5rem auto',
          },
        })}
      >
        <Button
          size="xs"
          variant="quaternaryText"
          aria-label={t(playing ? 'pausePlayback' : 'play')}
          isDisabled={playDisabled}
          onPress={onPlayPause}
          className={cx(
            action,
            css({
              gridArea: 'play',
              color: 'action.primary.bg',
              _disabled: { color: 'icon.disabled' },
            })
          )}
        >
          {playing ? (
            <RiPauseFill size={28} aria-hidden />
          ) : (
            <RiPlayFill size={28} aria-hidden />
          )}
        </Button>
        <Button
          size="xs"
          variant="quaternaryText"
          aria-label={t('skipBack')}
          tooltip={t('skipBack')}
          isDisabled={disabled}
          onPress={onBack}
          className={cx(action, css({ gridArea: 'back' }))}
        >
          <SkipFifteen />
        </Button>
        <Button
          size="xs"
          variant="quaternaryText"
          aria-label={t('skipForward')}
          tooltip={t('skipForward')}
          isDisabled={disabled || !end}
          onPress={onForward}
          className={cx(action, css({ gridArea: 'forward' }))}
        >
          <SkipFifteen forward />
        </Button>
        <div
          className={css({
            gridArea: 'volume',
            position: 'relative',
            justifySelf: 'center',
            '&:hover [data-volume-panel], &:focus-within [data-volume-panel]': {
              display: 'flex',
            },
          })}
        >
          <Button
            size="xs"
            variant="quaternaryText"
            aria-label={t(
              muted || volume === 0 ? 'unmutePlayback' : 'mutePlayback'
            )}
            aria-pressed={muted || volume === 0}
            onPress={onToggleMute}
            className={action}
          >
            {muted || volume === 0 ? (
              <RiVolumeMuteLine size={22} aria-hidden />
            ) : (
              <RiVolumeUpLine size={22} aria-hidden />
            )}
          </Button>
          <div
            data-volume-panel
            className={css({
              display: 'none',
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1,
              padding: 'sm',
              gap: 'sm',
              alignItems: 'center',
              backgroundColor: 'surface.default',
              border: '1px solid token(colors.border.subtle)',
              borderRadius: 'control',
            })}
          >
            <input
              type="range"
              aria-label={t('playbackVolume')}
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => onVolume(Number(event.target.value))}
              className={css({
                width: '5rem',
                height: '2.75rem',
                accentColor: 'action.primary.bg',
              })}
            />
            <span
              className={css({
                textStyle: 'labelMedium',
                color: 'text.secondary',
                minWidth: '3ch',
                fontVariantNumeric: 'tabular-nums',
              })}
            >
              {Math.round((muted ? 0 : volume) * 100)}%
            </span>
          </div>
        </div>
        <select
          aria-label={t('playbackRate')}
          value={rate}
          disabled={disabled}
          onChange={(event) => onRate(Number(event.target.value))}
          className={css({
            gridArea: 'speed',
            width: '100%',
            maxWidth: '5.5rem',
            minWidth: 0,
            // Override the global compact form-select chrome for touch playback.
            minHeight: '2.75rem !important',
            justifySelf: 'center',
            padding: '0 !important',
            backgroundImage: 'none !important',
            border: '0 !important',
            textAlign: 'center',
            borderRadius: 'control',
            color: 'text.primary',
            backgroundColor: 'surface.default',
            textStyle: 'labelLarge',
            cursor: 'pointer',
            _hover: { backgroundColor: 'surface.canvas' },
            _focusVisible: { outline: '2px solid token(colors.border.focus)' },
          })}
        >
          {[0.75, 1, 1.25, 1.5, 2].map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>
        <PlaybackTime position={position} duration={end} />
      </div>
    </div>
  )
}

function SkipFifteen({ forward = false }: { forward?: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 30 30"
      fill="none"
      aria-hidden="true"
    >
      <g transform={forward ? 'translate(30 0) scale(-1 1)' : undefined}>
        <path
          d="M9 7a11 11 0 1 1-4.7 11"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M10 2 4 8l7 3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <text
        x="15"
        y="21"
        textAnchor="middle"
        fill="currentColor"
        fontSize="11"
        fontWeight="600"
      >
        15
      </text>
    </svg>
  )
}
