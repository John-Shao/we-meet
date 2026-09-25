import { useLayoutEffect, useRef, type UIEvent } from 'react'
import { useRecordViewState } from './useRecordViewState'

/** Restore after async rows arrive, unless the reader starts navigating. */
export function useRecordPanelScroll(key: string) {
  const [savedTop, saveTop] = useRecordViewState(`scroll:${key}`, 0)
  const ref = useRef<HTMLDivElement>(null)
  const restoreTop = useRef<number | null>(savedTop)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const restore = () => {
      if (restoreTop.current === null) return
      el.scrollTop = restoreTop.current
      if (Math.abs(el.scrollTop - restoreTop.current) < 1)
        restoreTop.current = null
    }
    restore()
    const observer = new MutationObserver(restore)
    observer.observe(el, { subtree: true, childList: true })
    return () => observer.disconnect()
  }, [])
  const cancel = () => {
    restoreTop.current = null
  }
  return {
    ref,
    onWheel: cancel,
    onTouchStart: cancel,
    onKeyDown: cancel,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      if (restoreTop.current === null) saveTop(event.currentTarget.scrollTop)
    },
  }
}
