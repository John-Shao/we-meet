import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  READ_ONLY_VIEWPORT_QUERY,
  useReadOnlyViewport,
} from './useReadOnlyViewport'

type ChangeListener = (event: MediaQueryListEvent) => void

const createMediaQuery = (matches: boolean) => {
  const listeners = new Set<ChangeListener>()
  const mediaQuery = {
    matches,
    media: READ_ONLY_VIEWPORT_QUERY,
    onchange: null,
    addEventListener: vi.fn((type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.delete(listener)
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }
  const change = (next: boolean) => {
    mediaQuery.matches = next
    for (const listener of listeners) {
      listener({ matches: next } as MediaQueryListEvent)
    }
  }
  return { mediaQuery, listeners, change }
}

const stubMatchMedia = (matches: boolean) => {
  const query = createMediaQuery(matches)
  const matchMedia = vi.fn(() => query.mediaQuery)
  vi.stubGlobal('matchMedia', matchMedia)
  return { ...query, matchMedia }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useReadOnlyViewport', () => {
  it('defaults to false when matchMedia cannot be read', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useReadOnlyViewport())
    expect(result.current).toBe(false)
  })

  it('follows change events from the 767px media query', () => {
    const { change, mediaQuery, matchMedia } = stubMatchMedia(false)
    const { result } = renderHook(() => useReadOnlyViewport())
    expect(matchMedia).toHaveBeenCalledWith(READ_ONLY_VIEWPORT_QUERY)
    expect(result.current).toBe(false)
    act(() => change(true))
    expect(result.current).toBe(true)
    act(() => change(false))
    expect(result.current).toBe(false)
    expect(mediaQuery.addEventListener).toHaveBeenCalledTimes(1)
  })

  it('removes the change listener on unmount', () => {
    const { listeners, mediaQuery } = stubMatchMedia(true)
    const { result, unmount } = renderHook(() => useReadOnlyViewport())
    expect(result.current).toBe(true)
    const listener = [...listeners][0]
    expect(listener).toBeDefined()
    unmount()
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith(
      'change',
      listener
    )
    expect(listeners.size).toBe(0)
  })
})
