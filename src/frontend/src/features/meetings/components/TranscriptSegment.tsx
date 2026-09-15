import { RiUser3Line } from '@remixicon/react'
import { css } from '@/styled-system/css'

/** Keep speaker identity and source time together, with room to read the transcript. */
export function TranscriptSegment({
  speaker,
  time,
  text,
  onSeek,
  seekLabel,
}: {
  speaker: string
  time: string
  text: string
  onSeek?: () => void
  seekLabel?: string
}) {
  return (
    <article
      className={css({ padding: '1.25rem 0', overflowWrap: 'anywhere' })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.625rem',
          marginBottom: '0.875rem',
          color: 'greyscale.600',
          fontSize: '0.875rem',
        })}
      >
        <span
          aria-hidden
          className={css({
            display: 'grid',
            placeItems: 'center',
            width: '2rem',
            height: '2rem',
            borderRadius: '50%',
            backgroundColor: 'primary.100',
            color: 'primary.600',
            flexShrink: 0,
          })}
        >
          <RiUser3Line size={17} />
        </span>
        <span>{speaker}</span>
        <span aria-hidden>·</span>
        {onSeek ? (
          <button
            type="button"
            onClick={onSeek}
            aria-label={seekLabel}
            className={css({
              cursor: 'pointer',
              color: 'primary.700',
              borderRadius: '0.25rem',
              padding: '0.25rem',
              _hover: { backgroundColor: 'primary.100' },
              _focusVisible: { outline: '2px solid token(colors.primary.500)' },
            })}
          >
            {time}
          </button>
        ) : (
          <span>{time}</span>
        )}
      </div>
      <p
        className={css({
          whiteSpace: 'pre-wrap',
          fontSize: '1rem',
          lineHeight: 1.9,
          color: 'greyscale.900',
        })}
      >
        {text}
      </p>
    </article>
  )
}
