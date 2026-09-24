import { useEffect, useRef, type MouseEvent } from 'react'
import { useHistoryState } from 'wouter/use-browser-location'
import { useLocation } from 'wouter'

type ListSnapshot<T = unknown> = {
  viewerId: string
  path: string
  href: string
  value: T
  scrollTop: number
}
type NavigationState<T = unknown> = { meetingList?: ListSnapshot<T> }

export function readMeetingListState<T>(viewerId: string, path: string) {
  const saved = (window.history.state as NavigationState<T> | null)?.meetingList
  return saved?.viewerId === viewerId && saved.path === path ? saved : undefined
}

/** A snapshot belongs to a history entry and viewer, never a global last-used list. */
export function useMeetingListNavigation<T>(
  viewerId: string,
  path: string,
  value: T
) {
  const region = useRef<HTMLDivElement>(null)
  const [, navigate] = useLocation()
  useEffect(() => {
    const element = region.current
    const top = readMeetingListState<T>(viewerId, path)?.scrollTop ?? 0
    if (!element || !top) return
    const restore = () => {
      element.scrollTop = top
      if (element.scrollTop >= top) observer.disconnect()
    }
    const observer = new MutationObserver(restore)
    observer.observe(element, { childList: true, subtree: true })
    restore()
    const stop = () => observer.disconnect()
    element.addEventListener('wheel', stop, { passive: true })
    element.addEventListener('pointerdown', stop)
    element.addEventListener('keydown', stop)
    return () => {
      observer.disconnect()
      element.removeEventListener('wheel', stop)
      element.removeEventListener('pointerdown', stop)
      element.removeEventListener('keydown', stop)
    }
  }, [viewerId, path])

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as Element).closest('a')
    if (
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.target === '_blank'
    )
      return
    const target = new URL(anchor.href)
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith('/meeting/')
    )
      return
    const meetingList: ListSnapshot<T> = {
      viewerId,
      path,
      href: path + window.location.search,
      value,
      scrollTop: region.current?.scrollTop ?? 0,
    }
    const state = { ...window.history.state, meetingList }
    window.history.replaceState(state, '')
    event.preventDefault()
    navigate(target.pathname + target.search + target.hash, { state })
  }
  return { region, onClickCapture }
}

export function useMeetingListReturn(
  viewerId: string | undefined,
  path: string
) {
  const state = useHistoryState<NavigationState | null>()
  const saved = state?.meetingList
  const valid =
    saved?.viewerId === viewerId &&
    saved?.path === path &&
    saved.href.split('?')[0] === path
  return {
    href: valid ? saved.href : path,
    state: valid ? { meetingList: saved } : null,
  }
}
