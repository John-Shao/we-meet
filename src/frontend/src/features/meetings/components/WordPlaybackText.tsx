import { memo, useEffect, useMemo, useRef } from 'react'
import { css } from '@/styled-system/css'
import { type WordToken } from '../wordAlignment'

/** Plain inline text keeps selection and paragraph accessibility intact. */
export const WordPlaybackText = memo(function WordPlaybackText({
  text,
  tokens,
  active,
  query = '',
  onSeek,
}: {
  text: string
  tokens: WordToken[]
  active: number
  query?: string
  onSeek?: (ms: number) => void
}) {
  const down = useRef<{ x: number; y: number; time: number }>()
  const pending = useRef<ReturnType<typeof setTimeout>>()
  const latestSeek = useRef(onSeek)
  latestSeek.current = onSeek
  const cancelSeek = () => {
    clearTimeout(pending.current)
    pending.current = undefined
  }
  useEffect(() => {
    const selectionChanged = () => {
      if (!window.getSelection()?.isCollapsed) cancelSeek()
    }
    document.addEventListener('selectionchange', selectionChanged)
    return () => {
      cancelSeek()
      down.current = undefined
      document.removeEventListener('selectionchange', selectionChanged)
    }
  }, [text, tokens])
  const pieces = useMemo(() => {
    const matches: Array<[number, number]> = []
    if (query.trim()) {
      const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      for (const match of text.matchAll(new RegExp(escaped, 'giu')))
        matches.push([match.index, match.index + match[0].length])
    }
    const cuts = [
      ...new Set([
        0,
        text.length,
        ...tokens.flatMap((t) => [t.start_offset, t.end_offset]),
        ...matches.flat(),
      ]),
    ].sort((a, b) => a - b)
    let tokenCursor = 0
    let matchCursor = 0
    return cuts.slice(0, -1).map((start, i) => {
      const end = cuts[i + 1]
      while (
        tokenCursor < tokens.length &&
        tokens[tokenCursor].end_offset <= start
      )
        tokenCursor++
      const token = tokens[tokenCursor]
      while (matchCursor < matches.length && matches[matchCursor][1] <= start)
        matchCursor++
      const match = matches[matchCursor]
      return {
        start,
        end,
        tokenIndex:
          token && start >= token.start_offset && end <= token.end_offset
            ? tokenCursor
            : -1,
        found: !!match && start >= match[0] && end <= match[1],
      }
    })
  }, [text, tokens, query])
  return (
    <span
      onPointerDown={(e) => {
        cancelSeek()
        down.current = undefined
        if (
          e.button !== 0 ||
          e.isPrimary === false ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.shiftKey
        )
          return
        down.current = { x: e.clientX, y: e.clientY, time: Date.now() }
      }}
      // Pointer enhancement only: keyboard/AT retain the segment's seek button.
      onPointerCancel={() => {
        cancelSeek()
        down.current = undefined
      }}
      onPointerUp={(e) => {
        const gesture = down.current
        down.current = undefined
        if (
          !gesture ||
          e.button !== 0 ||
          Date.now() - gesture.time > 450 ||
          Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 5 ||
          !window.getSelection()?.isCollapsed
        )
          return
        const index = (e.target as HTMLElement).dataset.wordIndex
        const word = index === undefined ? undefined : tokens[Number(index)]
        if (word) {
          // Defer the first release so a second click/selection can cancel it.
          pending.current = setTimeout(() => {
            if (window.getSelection()?.isCollapsed)
              latestSeek.current?.(word.start_ms)
          }, 500)
        }
      }}
    >
      {pieces.map(({ start, end, tokenIndex, found }) => {
        const playing = tokenIndex >= 0 && tokenIndex === active
        return (
          <span
            key={start}
            data-word-index={tokenIndex >= 0 ? tokenIndex : undefined}
            data-playing-word={playing ? `${tokenIndex}` : undefined}
            className={css({
              '&[data-word-index]': { cursor: 'pointer' },
              '&[data-playing-word]': {
                backgroundColor: 'action.primary.bg',
                color: 'action.primary.text',
                borderRadius: 'field',
              },
            })}
            style={found ? { textDecoration: 'underline' } : undefined}
          >
            {text.slice(start, end)}
          </span>
        )
      })}
    </span>
  )
})
