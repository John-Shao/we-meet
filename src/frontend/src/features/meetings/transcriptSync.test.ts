import { describe, expect, it } from 'vitest'

import { activeRowId, nearestStartedRowId, type TimedRow } from './transcriptSync'

/** Contiguous rows, as a normal recording produces. */
const rows: TimedRow[] = [
  { id: 'a', start_ms: 0, end_ms: 1000 },
  { id: 'b', start_ms: 1000, end_ms: 2500 },
  { id: 'c', start_ms: 2500, end_ms: 4000 },
]

/** A recording with a hole: nothing was captured between 1000 and 3000. */
const gapped: TimedRow[] = [
  { id: 'a', start_ms: 0, end_ms: 1000 },
  { id: 'b', start_ms: 3000, end_ms: 4000 },
]

describe('activeRowId', () => {
  it('marks the row whose window contains the position', () => {
    expect(activeRowId(rows, 0)).toBe('a')
    expect(activeRowId(rows, 999)).toBe('a')
    expect(activeRowId(rows, 1000)).toBe('b')
    expect(activeRowId(rows, 2499)).toBe('b')
    expect(activeRowId(rows, 2500)).toBe('c')
  })

  it('treats the window as half-open so a boundary belongs to one row only', () => {
    // 1000 is b's start and a's end; exactly one row may claim it.
    const atBoundary = activeRowId(rows, 1000)
    expect(atBoundary).toBe('b')
    expect(activeRowId([...rows], 1000)).not.toBe('a')
  })

  it('reports no active row inside a recording gap', () => {
    // Highlighting a neighbour here would point at text nobody is speaking.
    expect(activeRowId(gapped, 2000)).toBeNull()
    expect(activeRowId(gapped, 2999)).toBeNull()
  })

  it('keeps the final row active when it has no end', () => {
    const open: TimedRow[] = [{ id: 'only', start_ms: 0, end_ms: null }]
    expect(activeRowId(open, 0)).toBe('only')
    expect(activeRowId(open, 999_999)).toBe('only')
  })

  it('returns nothing before the first row starts', () => {
    const late: TimedRow[] = [{ id: 'a', start_ms: 5000, end_ms: 6000 }]
    expect(activeRowId(late, 0)).toBeNull()
    expect(activeRowId(late, 4999)).toBeNull()
    expect(activeRowId(late, 5000)).toBe('a')
  })

  it('returns nothing for an empty transcript or an unusable position', () => {
    expect(activeRowId([], 1000)).toBeNull()
    expect(activeRowId(rows, -1)).toBeNull()
    expect(activeRowId(rows, Number.NaN)).toBeNull()
    expect(activeRowId(rows, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('does not assume rows arrive sorted-by-window beyond transcript order', () => {
    // Rows are in transcript order; the scan stops at the first row that has
    // not started yet, so a later short row cannot be selected early.
    const overlapping: TimedRow[] = [
      { id: 'long', start_ms: 0, end_ms: 5000 },
      { id: 'next', start_ms: 5000, end_ms: 6000 },
    ]
    expect(activeRowId(overlapping, 4000)).toBe('long')
    expect(activeRowId(overlapping, 5000)).toBe('next')
  })
})

describe('nearestStartedRowId', () => {
  it('follows playback to the last row that already started', () => {
    expect(nearestStartedRowId(rows, 0)).toBe('a')
    expect(nearestStartedRowId(rows, 1500)).toBe('b')
    expect(nearestStartedRowId(rows, 999_999)).toBe('c')
  })

  it('still names a row inside a gap so the reader can see where playback is', () => {
    expect(nearestStartedRowId(gapped, 2000)).toBe('a')
  })

  it('returns nothing before anything has started', () => {
    expect(nearestStartedRowId(rows, -1)).toBeNull()
    expect(nearestStartedRowId([{ id: 'a', start_ms: 5000 }], 0)).toBeNull()
  })
})
