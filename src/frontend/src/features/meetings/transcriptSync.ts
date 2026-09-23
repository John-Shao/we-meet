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
  if (!rows.length || !Number.isFinite(positionMs) || positionMs < 0)
    return null
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

/** Fetch another bounded page only when playback leaves this page's window. */
export function transcriptWindowTarget(
  rows: readonly TimedRow[],
  positionMs: number,
  anchorMs: number,
  hasNext: boolean
): number | null {
  if (!rows.length || !Number.isFinite(positionMs) || positionMs < 0)
    return null
  const target = Math.floor(positionMs)
  if (target === anchorMs) return null
  if (anchorMs > 0 && positionMs < rows[0].start_ms) return target
  if (hasNext && positionMs >= rows[rows.length - 1].start_ms) return target
  return null
}

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
  enabled: boolean
  resumeEpoch: number
  pauseFollowing: () => void
  resumeFollowing: () => void
}

export type TranscriptPlaybackFollow = Pick<
  PlaybackFollow,
  'suppressed' | 'suppressionEpoch'
> &
  Partial<
    Pick<
      PlaybackFollow,
      | 'positionMs'
      | 'enabled'
      | 'resumeEpoch'
      | 'pauseFollowing'
      | 'resumeFollowing'
    >
  >

/** Explicit resume clears the list's filters using its latest clock, once per request. */
export function usePlaybackResume(
  follow: TranscriptPlaybackFollow | undefined,
  onResume: () => void
) {
  const latest = useRef(onResume)
  latest.current = onResume
  useEffect(() => {
    if (follow?.resumeEpoch) latest.current()
  }, [follow?.resumeEpoch])
}

/** Playback follows by default; browsing pauses it until an explicit return or seek. */
export function usePlaybackFollow(
  rows: readonly TimedRow[],
  canResume: () => boolean = () => true
): PlaybackFollow {
  const [positionMs, setPositionMs] = useState(0)
  const [suppressionEpoch, setSuppressionEpoch] = useState(0)
  const [enabled, setEnabled] = useState(true)
  const [resumeEpoch, setResumeEpoch] = useState(0)
  const enabledRef = useRef(true)
  const resumeAllowed = useRef(canResume)
  resumeAllowed.current = canResume
  const pauseFollowing = useCallback(() => {
    enabledRef.current = false
    setEnabled(false)
    setSuppressionEpoch((value) => value + 1)
  }, [])
  const resumeFollowing = useCallback(() => {
    if (!resumeAllowed.current()) return
    enabledRef.current = true
    setEnabled(true)
    setResumeEpoch((value) => value + 1)
    setSuppressionEpoch((value) => value + 1)
  }, [])
  const suppressed = useCallback(
    () => !enabledRef.current || !resumeAllowed.current(),
    []
  )
  const report = useCallback(
    (milliseconds: number) => setPositionMs(milliseconds),
    []
  )
  return {
    positionMs,
    activeId: activeRowId(rows, positionMs),
    report,
    suppressed,
    suppressionEpoch,
    enabled,
    resumeEpoch,
    pauseFollowing,
    resumeFollowing,
  }
}

/**
 * Keep the right row in view, once per change, from the list rather than from
 * every row.
 *
 * Why the list: if each row scrolled itself, every mounted row would run its own
 * effect on each active change, so a seek across the recording would fire a
 * scroll request from every row it passed — all in one commit, racing, and the
 * list could settle anywhere. One owner makes it a single request for the row
 * that actually matters.
 *
 * The highlight and the scroll have different targets on purpose. Playback can
 * sit in a gap, where no row is being spoken and none should be highlighted;
 * the view still has to follow, or the text stalls behind the audio until the
 * next row starts. So the highlight is the row whose window contains the
 * position, and the scroll target is the last row that has already started.
 *
 * Scrolling is refused while the reader holds control (see
 * {@link usePlaybackFollow}). Reduced-motion is honoured. A missing
 * `scrollIntoView` — jsdom, or a detached node — is tolerated rather than
 * throwing, because following is a progressive enhancement.
 */
export function useTranscriptFollow({
  containerRef,
  activeId,
  rows = [],
  follow,
  enabled = true,
}: {
  containerRef: RefObject<HTMLElement | null>
  activeId: string | null
  /** Same rows the highlight was derived from, for the gap-following target. */
  rows?: readonly TimedRow[]
  follow: TranscriptPlaybackFollow & {
    /** Required for gap-following; omit to follow the highlight only. */
    positionMs?: number
  }
  /** False when a filter is applied and the active row may not be rendered. */
  enabled?: boolean
}) {
  const scrolled = useRef<string | null>(null)
  // Position lives in a ref because the effect must react to the *target*, not
  // to every tick: re-scrolling to a row already in view would fight the
  // reader's own scrolling for the whole of a long utterance.
  const position = useRef(0)
  const lastEpoch = useRef(follow.suppressionEpoch)
  // Gap-following needs a clock. A caller that only supplies a pre-derived
  // `activeId` gets exactly the old behaviour, because without a position there
  // is no way to say which row has already started.
  const gapFollow = follow.positionMs !== undefined
  position.current = follow.positionMs ?? 0
  // A gesture that suspends following invalidates where we last scrolled, so
  // the next eligible target is applied even if it is the same row.
  if (lastEpoch.current !== follow.suppressionEpoch) {
    lastEpoch.current = follow.suppressionEpoch
    scrolled.current = null
  }

  const target =
    activeId ?? (gapFollow ? nearestStartedRowId(rows, position.current) : null)
  const pauseFollowing = follow.pauseFollowing

  useEffect(() => {
    const list = containerRef.current
    if (!list || !pauseFollowing) return
    let scroller = list
    while (
      scroller.parentElement &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    ) {
      scroller = scroller.parentElement
    }
    // Never let gestures elsewhere on the page suspend this transcript.
    if (scroller === document.body || scroller === document.documentElement)
      scroller = list
    const pause = () => pauseFollowing()
    const selection = () => {
      const selected = window.getSelection()
      if (
        selected &&
        !selected.isCollapsed &&
        selected.anchorNode &&
        list.contains(selected.anchorNode)
      )
        pause()
    }
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as Element)?.closest(
          'input, textarea, select, button, [contenteditable=true]'
        )
      )
        return
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'PageUp',
          'PageDown',
          'Home',
          'End',
          ' ',
        ].includes(event.key)
      )
        pause()
    }
    const pointer = (event: PointerEvent) => {
      if (
        event.target === scroller &&
        scroller.scrollHeight > scroller.clientHeight
      )
        pause()
    }
    scroller.addEventListener('wheel', pause, { passive: true })
    scroller.addEventListener('touchmove', pause, { passive: true })
    scroller.addEventListener('keydown', key)
    scroller.addEventListener('pointerdown', pointer)
    document.addEventListener('selectionchange', selection)
    return () => {
      scroller.removeEventListener('wheel', pause)
      scroller.removeEventListener('touchmove', pause)
      scroller.removeEventListener('keydown', key)
      scroller.removeEventListener('pointerdown', pointer)
      document.removeEventListener('selectionchange', selection)
    }
  }, [containerRef, pauseFollowing, target])

  useEffect(() => {
    if (!enabled || follow.enabled === false || target === null) return
    if (follow.suppressed()) return
    const container = containerRef.current
    if (!container) return
    // Only a rendered row can be scrolled to; a filtered list may omit it.
    const row = container.querySelector<HTMLElement>(
      `[data-segment-id="${CSS.escape(target)}"]`
    )
    if (typeof row?.scrollIntoView !== 'function') return
    const word = row.querySelector<HTMLElement>('[data-playing-word]')
    const scrollKey = word ? `${target}:${word.dataset.playingWord}` : target
    if (scrolled.current === scrollKey) return
    scrolled.current = scrollKey
    let scrollParent: HTMLElement | null = container
    while (
      scrollParent.parentElement &&
      !/(auto|scroll)/.test(getComputedStyle(scrollParent).overflowY)
    )
      scrollParent = scrollParent.parentElement
    const bounds = scrollParent.getBoundingClientRect()
    const rect = (word ?? row).getBoundingClientRect()
    if (
      word &&
      bounds.height > 0 &&
      rect.top >= Math.max(0, bounds.top) + 48 &&
      rect.bottom <= Math.min(window.innerHeight, bounds.bottom) - 16
    )
      return
    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    ).matches
    ;(word ?? row).scrollIntoView({
      block: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    })
    // Explicitly returning to playback invalidates the previous scroll target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    target,
    enabled,
    follow.enabled,
    follow.suppressed,
    follow.suppressionEpoch,
    follow.positionMs,
  ])
}
