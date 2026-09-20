import { validMediaDuration } from '../recordMediaTiming'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApiSpeakerTimeline } from '../api/ApiCaptureSession'
import { css } from '@/styled-system/css'

const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

/** An extent of recognized speech, deliberately not a media-duration ruler. */
export function SpeakerTimeline({
  timeline,
  onSeek,
  mediaDuration,
}: {
  timeline?: ApiSpeakerTimeline
  onSeek?: (ms: number) => void
  mediaDuration?: number
}) {
  const { t } = useTranslation('meetings')
  const [page, setPage] = useState(0)
  if (!timeline) return null // older servers
  const { extent_ms: extent, intervals } = timeline
  const valid =
    timeline.basis === 'recognized_extent' &&
    ['available', 'partial'].includes(timeline.status) &&
    Number.isSafeInteger(extent) &&
    extent! > 0 &&
    Array.isArray(intervals) &&
    intervals.length > 0 &&
    intervals.length <= 1000 &&
    intervals.every(
      (span, index) =>
        Number.isSafeInteger(span.start_ms) &&
        Number.isSafeInteger(span.end_ms) &&
        span.start_ms >= 0 &&
        span.end_ms > span.start_ms &&
        span.end_ms <= extent! &&
        (index === 0 || span.start_ms > intervals[index - 1].end_ms)
    )
  if (!valid) return <p>{t('speakerTimeline.unavailable')}</p>
  const ruler =
    validMediaDuration(mediaDuration) && mediaDuration >= extent!
      ? mediaDuration
      : extent!
  const current = Math.min(page, Math.floor((intervals.length - 1) / 10))
  return (
    <div>
      <p>
        {t(
          ruler === mediaDuration
            ? 'mediaTiming.ruler'
            : 'speakerTimeline.basis',
          { end: time(ruler) }
        )}
      </p>
      <svg
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        aria-hidden="true"
        className={css({ width: '100%', height: '2rem', color: 'text.link' })}
      >
        <rect width="1000" height="24" fill="currentColor" opacity="0.1" />
        {intervals.map((span) => (
          <rect
            key={span.start_ms}
            x={(span.start_ms / ruler) * 1000}
            width={((span.end_ms - span.start_ms) / ruler) * 1000}
            height="24"
            fill="currentColor"
            onClick={onSeek ? () => onSeek(span.start_ms) : undefined}
          />
        ))}
      </svg>
      {timeline.status === 'partial' && <p>{t('speakerTimeline.partial')}</p>}
      {!onSeek && <p>{t('speakerTimeline.readOnly')}</p>}
      <details>
        <summary>
          {t('speakerTimeline.intervals', { count: intervals.length })}
        </summary>
        <ul>
          {intervals.slice(current * 10, current * 10 + 10).map((span) => (
            <li key={span.start_ms}>
              {onSeek ? (
                <button
                  type="button"
                  onClick={() => onSeek(span.start_ms)}
                  className={css({ minHeight: '2.75rem', color: 'text.link' })}
                >
                  {t('speakerTimeline.seek', {
                    start: time(span.start_ms),
                    end: time(span.end_ms),
                  })}
                </button>
              ) : (
                `${time(span.start_ms)} – ${time(span.end_ms)}`
              )}
            </li>
          ))}
        </ul>
        {current > 0 && (
          <button type="button" onClick={() => setPage(current - 1)}>
            {t('library.previous')}
          </button>
        )}
        {(current + 1) * 10 < intervals.length && (
          <button type="button" onClick={() => setPage(current + 1)}>
            {t('library.next')}
          </button>
        )}
      </details>
    </div>
  )
}
