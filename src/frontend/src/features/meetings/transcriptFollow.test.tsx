import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { createRef, useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activeRowId,
  useTranscriptFollow,
  usePlaybackFollow,
} from './transcriptSync'

it('keeps manual browsing paused until an explicit return, even while playback advances', () => {
  vi.useFakeTimers()
  try {
    const hook = renderHook(() => usePlaybackFollow([]))
    fireEvent.wheel(window)
    expect(hook.result.current.enabled).toBe(true)
    act(() => hook.result.current.pauseFollowing())
    act(() => {
      hook.result.current.report(42_000)
      vi.advanceTimersByTime(60_000)
    })
    expect(hook.result.current.suppressed()).toBe(true)
    act(() => hook.result.current.resumeFollowing())
    expect(hook.result.current.suppressed()).toBe(false)
    expect(hook.result.current.positionMs).toBe(42_000)
    hook.unmount()
  } finally {
    vi.useRealTimers()
  }
})

it('refuses explicit follow requests while an editor has an unsaved or pending draft', () => {
  let editing = true
  const hook = renderHook(() => usePlaybackFollow([], () => !editing))
  act(() => hook.result.current.pauseFollowing())
  act(() => hook.result.current.resumeFollowing())
  expect(hook.result.current.resumeEpoch).toBe(0)
  expect(hook.result.current.suppressed()).toBe(true)
  editing = false
  expect(hook.result.current.enabled).toBe(false)
  act(() => hook.result.current.resumeFollowing())
  expect(hook.result.current.resumeEpoch).toBe(1)
  expect(hook.result.current.enabled).toBe(true)
})

/**
 * The list owns the scroll, so it happens once per active change. When every row
 * asked to be scrolled instead, a seek across the recording fired a request from
 * every row it passed in the same commit and the list could settle anywhere.
 */

function Harness({
  activeId,
  suppressed = false,
  enabled = true,
  ids = ['a', 'b', 'c'],
}: {
  activeId: string | null
  suppressed?: boolean
  enabled?: boolean
  ids?: string[]
}) {
  const containerRef = createRef<HTMLDivElement>()
  useTranscriptFollow({
    containerRef,
    activeId,
    follow: { suppressed: () => suppressed, suppressionEpoch: 0 },
    enabled,
  })
  return (
    <div ref={containerRef} data-testid="list">
      {ids.map((id) => (
        <p key={id} data-segment-id={id}>
          {id}
        </p>
      ))}
    </div>
  )
}

/** jsdom has no layout, so the scroll call is observed rather than its effect. */

describe('useTranscriptFollow', () => {
  it('binds browsing to list readiness during silence and removes detached listeners', () => {
    const pause = vi.fn()
    function LoadingList({ ready }: { ready: boolean }) {
      const containerRef = useRef<HTMLDivElement>(null)
      useTranscriptFollow({
        containerRef,
        containerReady: ready,
        activeId: null,
        follow: {
          suppressed: () => false,
          suppressionEpoch: 0,
          pauseFollowing: pause,
        },
      })
      return ready ? (
        <div ref={containerRef} data-testid="ready-list" />
      ) : (
        <p>Loading</p>
      )
    }
    const view = render(<LoadingList ready={false} />)
    view.rerender(<LoadingList ready />)
    const oldList = screen.getByTestId('ready-list')
    fireEvent.wheel(oldList)
    expect(pause).toHaveBeenCalledTimes(1)
    view.rerender(<LoadingList ready={false} />)
    fireEvent.wheel(oldList)
    expect(pause).toHaveBeenCalledTimes(1)
    view.rerender(<LoadingList ready />)
    fireEvent.touchMove(screen.getByTestId('ready-list'))
    expect(pause).toHaveBeenCalledTimes(2)
    fireEvent.wheel(window)
    expect(pause).toHaveBeenCalledTimes(2)
  })

  it('scrolls only the active row, not every row it did not reach', () => {
    const scrolls: string[] = []
    function Tracked({ activeId }: { activeId: string }) {
      const containerRef = createRef<HTMLDivElement>()
      useTranscriptFollow({
        containerRef,
        activeId,
        follow: { suppressed: () => false, suppressionEpoch: 0 },
      })
      return (
        <div ref={containerRef}>
          {['a', 'b', 'c'].map((id) => (
            <p
              key={id}
              data-segment-id={id}
              ref={(node) => {
                if (node) {
                  node.scrollIntoView = () => scrolls.push(id)
                }
              }}
            >
              {id}
            </p>
          ))}
        </div>
      )
    }
    render(<Tracked activeId="c" />)
    // Exactly one scroll request, for the row playback is inside.
    expect(scrolls).toEqual(['c'])
  })

  it('does not scroll while the reader holds control', () => {
    const scrolls: string[] = []
    function Tracked() {
      const containerRef = createRef<HTMLDivElement>()
      useTranscriptFollow({
        containerRef,
        activeId: 'b',
        follow: { suppressed: () => true, suppressionEpoch: 0 },
      })
      return (
        <div ref={containerRef}>
          <p
            data-segment-id="b"
            ref={(n) => {
              if (n) n.scrollIntoView = () => scrolls.push('b')
            }}
          >
            b
          </p>
        </div>
      )
    }
    render(<Tracked />)
    expect(scrolls).toEqual([])
  })

  it('scrolls nothing when following is disabled by a filter', () => {
    const scrolls: string[] = []
    function Tracked() {
      const containerRef = createRef<HTMLDivElement>()
      useTranscriptFollow({
        containerRef,
        activeId: 'b',
        follow: { suppressed: () => false, suppressionEpoch: 0 },
        enabled: false,
      })
      return (
        <div ref={containerRef}>
          <p
            data-segment-id="b"
            ref={(n) => {
              if (n) n.scrollIntoView = () => scrolls.push('b')
            }}
          >
            b
          </p>
        </div>
      )
    }
    render(<Tracked />)
    expect(scrolls).toEqual([])
  })

  it('tolerates an active row that is not rendered', () => {
    // A filtered page can omit the row; that must not throw.
    render(<Harness activeId="missing" ids={['a', 'b']} />)
    expect(screen.getByTestId('list')).toBeInTheDocument()
  })

  it('tolerates a missing scrollIntoView', () => {
    function Bare() {
      const containerRef = createRef<HTMLDivElement>()
      useTranscriptFollow({
        containerRef,
        activeId: 'a',
        follow: { suppressed: () => false, suppressionEpoch: 0 },
      })
      // jsdom's default element has no scrollIntoView at all.
      return (
        <div ref={containerRef}>
          <p data-segment-id="a">a</p>
        </div>
      )
    }
    expect(() => render(<Bare />)).not.toThrow()
  })

  it('does nothing without an active row', () => {
    expect(() => render(<Harness activeId={null} />)).not.toThrow()
  })
})

/**
 * Playback can sit in a gap, where no row is being spoken. The highlight must
 * disappear there — naming a neighbour would mark text that is not being said —
 * but the view still has to follow, or the text stalls behind the audio.
 */
describe('useTranscriptFollow across a gap', () => {
  const rows = [
    { id: 'a', start_ms: 0, end_ms: 1000 },
    // A deliberate hole between 1000 and 5000.
    { id: 'b', start_ms: 5000, end_ms: 6000 },
  ]

  function GapHarness({ positionMs }: { positionMs: number }) {
    const containerRef = createRef<HTMLDivElement>()
    const activeId = activeRowId(rows, positionMs)
    useTranscriptFollow({
      containerRef,
      activeId,
      rows,
      follow: {
        suppressed: () => false,
        suppressionEpoch: 0,
        positionMs,
      },
    })
    return (
      <div ref={containerRef}>
        {rows.map((row) => (
          <p
            key={row.id}
            data-segment-id={row.id}
            ref={(node) => {
              if (node) node.scrollIntoView = () => scrolls.push(row.id)
            }}
          >
            {row.id}
          </p>
        ))}
      </div>
    )
  }

  let scrolls: string[] = []
  beforeEach(() => {
    scrolls = []
  })

  it('is inside a row while one is being spoken', () => {
    render(<GapHarness positionMs={200} />)
    expect(scrolls).toEqual(['a'])
  })

  it('follows the last row that started while sitting in the gap', () => {
    render(<GapHarness positionMs={3000} />)
    // No highlight is correct here, but the view must not be abandoned.
    expect(scrolls).toEqual(['a'])
  })

  it('advances when the next row starts', () => {
    render(<GapHarness positionMs={5200} />)
    expect(scrolls).toEqual(['b'])
  })

  it('follows the highlight alone when no clock is supplied', () => {
    // Callers that pass a pre-derived activeId keep the old behaviour: without a
    // position there is no way to say which row has already started.
    render(<Harness activeId={null} />)
    expect(screen.getByTestId('list')).toBeInTheDocument()
  })
})
