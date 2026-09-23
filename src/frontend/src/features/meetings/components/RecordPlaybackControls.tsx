import { RiCrosshair2Line, RiPauseFill, RiPlayFill } from '@remixicon/react'
import type { CSSProperties, InputHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives/Button'
import { css, cx } from '@/styled-system/css'

export type PlaybackFollowControl = {
  enabled: boolean
  onToggle: () => void
}

const playbackTime = (milliseconds: number) => {
  const seconds = Math.floor(
    Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000
  )
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const action = css({
  minWidth: '3rem',
  minHeight: '3rem',
  padding: 'xs',
  borderRadius: 'pill',
  justifySelf: 'center',
  textStyle: 'labelMedium',
})

/** Native range semantics and a 48px hit area around a 4px visual track. */
export function RecordPlaybackControls({
  position,
  duration,
  playing,
  rate,
  disabled = false,
  playDisabled = disabled,
  onPlayPause,
  onSeek,
  onRate,
  onBack,
  onForward,
  followControl,
  seekEvents,
}: {
  position: number
  duration: number
  playing: boolean
  rate: number
  disabled?: boolean
  playDisabled?: boolean
  onPlayPause: () => void
  onSeek: (milliseconds: number) => void
  onRate: (rate: number) => void
  onBack: () => void
  onForward: () => void
  followControl?: PlaybackFollowControl
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
      className={css({ width: '100%', maxWidth: '48rem', marginX: 'auto' })}
    >
      <div
        aria-live="off"
        className={css({
          display: 'flex',
          justifyContent: 'space-between',
          color: 'text.secondary',
          textStyle: 'labelMedium',
          fontVariantNumeric: 'tabular-nums',
        })}
      >
        <span>{playbackTime(position)}</span>
        <span>{end ? playbackTime(end) : '—'}</span>
      </div>
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
          height: '3rem',
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
              'linear-gradient(to right, token(colors.action.primary.bg) var(--playback-progress), token(colors.border.subtle) var(--playback-progress))',
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
            backgroundColor: 'border.subtle',
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
          gridTemplateColumns: 'minmax(0, 1fr) 3rem 3.5rem 3rem minmax(0, 1fr)',
          alignItems: 'center',
          columnGap: { base: 'xs', sm: 'lg' },
        })}
      >
        <select
          aria-label={t('playbackRate')}
          value={rate}
          disabled={disabled}
          onChange={(event) => onRate(Number(event.target.value))}
          className={css({
            width: '100%',
            maxWidth: '5.5rem',
            minWidth: 0,
            // Override the global compact form-select chrome for touch playback.
            minHeight: '3rem !important',
            justifySelf: 'center',
            padding: '0 !important',
            backgroundImage: 'none !important',
            textAlign: 'center',
            borderRadius: 'control',
            color: 'text.link',
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
        <Button
          size="xs"
          round
          variant="quaternaryText"
          aria-label={t('skipBack')}
          tooltip={t('skipBack')}
          isDisabled={disabled}
          onPress={onBack}
          className={action}
        >
          <SkipFifteen />
        </Button>
        <Button
          size="xs"
          round
          variant="primary"
          aria-label={t(playing ? 'pausePlayback' : 'play')}
          isDisabled={playDisabled}
          onPress={onPlayPause}
          className={cx(
            action,
            css({ width: '3.5rem', height: '3.5rem', padding: 0 })
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
          round
          variant="quaternaryText"
          aria-label={t('skipForward')}
          tooltip={t('skipForward')}
          isDisabled={disabled || !end}
          onPress={onForward}
          className={action}
        >
          <SkipFifteen forward />
        </Button>
        <div className={css({ minWidth: 0, justifySelf: 'center' })}>
          {followControl && (
            <Button
              size="xs"
              round
              variant="quaternaryText"
              aria-label={t('followPlayback')}
              aria-pressed={followControl.enabled}
              onPress={followControl.onToggle}
              className={cx(
                action,
                css({
                  color: 'text.secondary',
                  '&[aria-pressed=true]': {
                    color: 'text.link',
                    backgroundColor: 'action.selected.bg',
                  },
                })
              )}
            >
              <span
                className={css({
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 'xxs',
                })}
              >
                <RiCrosshair2Line size={20} aria-hidden />
                <span>{t('followPlayback')}</span>
              </span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function SkipFifteen({ forward = false }: { forward?: boolean }) {
  return (
    <svg
      width="30"
      height="30"
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
