import { webcrypto, createHash } from 'node:crypto'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { WordPlaybackText } from './WordPlaybackText'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TranscriptSegment } from './TranscriptSegment'
import type { PlaybackAlignment } from '../wordAlignment'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('PointerEvent', MouseEvent)
})
afterEach(() => vi.unstubAllGlobals())
it('tracks repeated words, preserves text and prevents selection/long-press seeks', async () => {
  const text = 'Hello, Hello.'
  const alignment: PlaybackAlignment = {
    status: 'available',
    version: 1,
    alignment_revision: 1,
    time_basis: 'segment_source',
    offset_unit: 'utf16',
    text_sha256: createHash('sha256').update(text).digest('hex'),
    tokens: [
      { start_offset: 0, end_offset: 5, start_ms: 0, end_ms: 300 },
      { start_offset: 7, end_offset: 12, start_ms: 500, end_ms: 1000 },
    ],
  }
  const onWordSeek = vi.fn()
  const props = {
    segmentId: 's',
    speaker: 'A',
    text,
    playbackAlignment: alignment,
    active: true,
    onWordSeek,
  }
  const view = render(
    <TranscriptSegment {...props} positionMs={600} highlight="Hello" />
  )
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-playing-word]')?.textContent
    ).toBe('Hello')
  )
  expect(view.container.querySelector('p')?.textContent).toBe(text)
  const second = view.container.querySelector('[data-word-index="1"]')!
  fireEvent.pointerDown(second, { clientX: 10, clientY: 10 })
  fireEvent.pointerUp(second, { clientX: 10, clientY: 10 })
  await waitFor(() => expect(onWordSeek).toHaveBeenCalledWith(500))
  const range = document.createRange()
  range.selectNodeContents(second)
  window.getSelection()!.addRange(range)
  fireEvent.pointerDown(second)
  fireEvent.pointerUp(second)
  expect(onWordSeek).toHaveBeenCalledTimes(1)
  window.getSelection()!.removeAllRanges()
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  fireEvent.pointerDown(second)
  now.mockReturnValue(1600)
  fireEvent.pointerUp(second)
  expect(onWordSeek).toHaveBeenCalledTimes(1)
  now.mockRestore()
  view.rerender(<TranscriptSegment {...props} positionMs={400} />)
  expect(view.container.querySelector('[data-playing-word]')).toBeNull()
  view.rerender(
    <TranscriptSegment {...props} text="Corrected text" positionMs={600} />
  )
  expect(view.container.querySelector('[data-word-index]')).toBeNull()
  expect(view.container.querySelector('p')?.textContent).toBe('Corrected text')
})

it('ignores secondary clicks and cancels pending single clicks for selection or unmount', () => {
  vi.useFakeTimers()
  const onSeek = vi.fn()
  const tokens = [
    { start_offset: 0, end_offset: 5, start_ms: 500, end_ms: 1000 },
  ]
  const view = render(
    <WordPlaybackText text="Hello" tokens={tokens} active={0} onSeek={onSeek} />
  )
  const word = view.getByText('Hello')
  try {
    for (const button of [1, 2]) {
      fireEvent.pointerDown(word, { button })
      fireEvent.pointerUp(word, { button })
      act(() => vi.advanceTimersByTime(600))
    }
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.pointerDown(word, { button: 0 })
    fireEvent.pointerUp(word, { button: 0 })
    act(() => vi.advanceTimersByTime(100))
    fireEvent.pointerDown(word, { button: 0 })
    const range = document.createRange()
    range.selectNodeContents(word)
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    fireEvent.pointerUp(word, { button: 0 })
    act(() => vi.advanceTimersByTime(600))
    expect(onSeek).not.toHaveBeenCalled()
    window.getSelection()!.removeAllRanges()
    fireEvent.pointerDown(word, { button: 0 })
    fireEvent.pointerUp(word, { button: 0 })
    view.unmount()
    act(() => vi.advanceTimersByTime(600))
    expect(onSeek).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
    window.getSelection()!.removeAllRanges()
  }
})
