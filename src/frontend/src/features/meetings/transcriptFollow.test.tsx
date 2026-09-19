import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import { useTranscriptFollow } from './transcriptSync'

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
          <p data-segment-id="b" ref={(n) => { if (n) n.scrollIntoView = () => scrolls.push('b') }}>
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
          <p data-segment-id="b" ref={(n) => { if (n) n.scrollIntoView = () => scrolls.push('b') }}>
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
