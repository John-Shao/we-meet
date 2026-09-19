import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Playback ↔ transcript coupling.
 *
 * The player owns the clock; the transcript owns the text. They only agree once
 * somebody maps playback milliseconds onto a row's `[start_ms, end_ms)` window,
 * so this module holds that mapping in one place instead of letting each side
 * invent its own.
 *
 * Deliberately not a hook for the mapping itself: the window arithmetic is the
 * part worth testing directly, and a pure function needs no DOM to prove it.
 */

/** A row that carries its own source window. */
export type TimedRow = { id: string; start_ms: number; end_ms?: number | null }

/**
 * The row whose window contains `positionMs`.
 *
 * Rows are in transcript order and are normally contiguous, but a recording can
 * have gaps (the manifest stores them explicitly), in which case playback sits
 * between two rows and no row is active — returning a neighbour there would
 * highlight text that is not being spoken.
 *
 * A row with no `end_ms` is the last one; it stays active until playback ends.
 */
export function activeRowId(
  rows: readonly TimedRow[],
  positionMs: number
): string | null {
  if (!rows.length || !Number.isFinite(positionMs) || positionMs < 0) return null
  let candidate: TimedRow | null = null
  for (const row of rows) {
    if (row.start_ms > positionMs) break
    candidate = row
  }
  if (!candidate) return null
  const end = candidate.end_ms
  if (end == null) return candidate.id
  return positionMs < end ? candidate.id : null
}

/** The last row that has already started, used to follow playback across gaps. */
export function nearestStartedRowId(
  rows: readonly TimedRow[],
  positionMs: number
): string | null {
  let candidate: string | null = null
  for (const row of rows) {
    if (row.start_ms > positionMs) break
    candidate = row.id
  }
  return candidate
}

/** How long a reader keeps control after scrolling before playback takes over. */
export const SCROLL_SUPPRESSION_MS = 4000

export type PlaybackFollow = {
  /** Latest playback position, in the same clock the rows use. */
  positionMs: number
  /** Row to highlight, or null in a gap. */
  activeId: string | null
  /** Report a new position from the player. */
  report: (milliseconds: number) => void
  /** True while a manual scroll should keep auto-scroll from stealing focus. */
  suppressed: () => boolean
  /** Bumped when a gesture changes suppression, to re-render followers. */
  suppressionEpoch: number
}

/**
 * Follow playback without fighting the reader.
 *
 * Only a physical scroll gesture suppresses following, and only for
 * {@link SCROLL_SUPPRESSION_MS}. A seek is deliberately *not* suppressed: the
 * reader clicked a row or dragged the timeline to see that moment, so bringing
 * its text into view is the point rather than an intrusion.
 */
export function usePlaybackFollow(rows: readonly TimedRow[]): PlaybackFollow {
  const [positionMs, setPositionMs] = useState(0)
  const suppressedUntil = useRef(0)
  const [suppressionEpoch, setSuppressionEpoch] = useState(0)

  const suppressed = useCallback(
    () => performance.now() < suppressedUntil.current,
    []
  )

  const report = useCallback((milliseconds: number) => {
    setPositionMs(milliseconds)
  }, [])

  // A wheel or touch gesture in the transcript means the reader is looking
  // somewhere specific; hold auto-scroll off until they stop.
  useEffect(() => {
    const note = () => {
      suppressedUntil.current = performance.now() + SCROLL_SUPPRESSION_MS
      // A gesture while paused must still re-render, otherwise the highlight
      // would stay put until the next position tick that may never come.
      setSuppressionEpoch((value) => value + 1)
    }
    window.addEventListener('wheel', note, { passive: true })
    window.addEventListener('touchmove', note, { passive: true })
    return () => {
      window.removeEventListener('wheel', note)
      window.removeEventListener('touchmove', note)
    }
  }, [])

  return {
    positionMs,
    activeId: activeRowId(rows, positionMs),
    report,
    suppressed,
    suppressionEpoch,
  }
}

/**
 * Keep the active row in view, once per change, from the list rather than from
 * every row.
 *
 * Why the list: if each row scrolled itself, every mounted row would run its own
 * effect on each active change, so a seek across the recording would fire a
 * scroll request from every row it passed — all in one commit, racing, and the
 * list could settle anywhere. One owner makes it a single request for the row
 * that actually matters.
 *
 * Scrolling is refused while the reader holds control (see
 * {@link usePlaybackFollow}). Reduced-motion is honoured. A missing
 * `scrollIntoView` — jsdom, or a detached node — is tolerated rather than
 * throwing, because following is a progressive enhancement.
 */
export function useTranscriptFollow({
  containerRef,
  activeId,
  follow,
  enabled = true,
}: {
  containerRef: RefObject<HTMLElement | null>
  activeId: string | null
  follow: Pick<PlaybackFollow, 'suppressed' | 'suppressionEpoch'>
  /** False when a filter is applied and the active row may not be rendered. */
  enabled?: boolean
}) {
  useEffect(() => {
    if (!enabled || activeId === null) return
    if (follow.suppressed()) return
    const container = containerRef.current
    if (!container) return
    // Only a rendered row can be scrolled to; a filtered list may omit it.
    const row = container.querySelector<HTMLElement>(
      `[data-segment-id="${CSS.escape(activeId)}"]`
    )
    if (typeof row?.scrollIntoView !== 'function') return
    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    ).matches
    row.scrollIntoView({
      block: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    })
    // suppressionEpoch is the signal that a gesture's window lapsed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, enabled, follow.suppressed, follow.suppressionEpoch])
}
