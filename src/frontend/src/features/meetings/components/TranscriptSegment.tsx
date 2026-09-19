import { RiUser3Line } from '@remixicon/react'
import { css, cx } from '@/styled-system/css'

/** Keep speaker identity and source time together, with room to read the transcript. */
export function TranscriptSegment({
  speaker,
  time,
  text,
  onSeek,
  seekLabel,
  segmentId,
  active = false,
}: {
  speaker: string
  time: string
  text: string
  onSeek?: () => void
  seekLabel?: string
  /** Identifies this row to the list that scrolls it into view. */
  segmentId: string
  /**
   * True while playback is inside this row. Passed in rather than derived here
   * so the row stays a leaf: the list decides which row is active and which row
   * gets scrolled, exactly once per change.
   */
  active?: boolean
}) {
  return (
    <article
      // The list finds the active row by this attribute, so a filtered list can
      // simply not find it instead of needing a second source of truth.
      data-segment-id={segmentId}
      // aria-current is the accessible signal; the left rule is its visual twin.
      aria-current={active ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      className={cx(
        css({
          padding: '1.25rem 0',
          overflowWrap: 'anywhere',
          borderLeft: '3px solid transparent',
          paddingLeft: '0.75rem',
          marginLeft: '-0.75rem',
          transition: 'background-color 150ms ease',
        }),
        active &&
          css({
            backgroundColor: 'primary.50',
            borderLeftColor: 'primary.500',
          })
      )}
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
