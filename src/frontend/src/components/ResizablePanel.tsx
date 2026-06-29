import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'

/**
 * Feishu-style resizable secondary panel. Wraps a fixed-width side panel and
 * adds a draggable right edge; the chosen width persists in localStorage under
 * `storageKey`. The child fills 100% width/height — keep the panel's own
 * background/border/padding/scroll on the child's root element.
 *
 * The drag handle straddles the panel's right border, shows a faint blue line
 * on hover, and is solid blue while dragging.
 */

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

interface Props {
  storageKey: string
  defaultWidth: number
  min?: number
  max?: number
  children: ReactNode
}

export const ResizablePanel = ({
  storageKey,
  defaultWidth,
  min = 200,
  max = 480,
  children,
}: Props) => {
  const { t } = useTranslation('shell')

  const [width, setWidthState] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved >= min && saved <= max
      ? saved
      : defaultWidth
  })
  const widthRef = useRef(width)
  const [dragging, setDragging] = useState(false)

  const setWidth = (w: number) => {
    widthRef.current = w
    setWidthState(w)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    setDragging(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (ev: PointerEvent) =>
      setWidth(clamp(startW + (ev.clientX - startX), min, max))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      try {
        localStorage.setItem(storageKey, String(widthRef.current))
      } catch {
        /* private mode / quota — width still applies for this session */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={css({ position: 'relative', flexShrink: 0, height: '100%' })}
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeHandle')}
        onPointerDown={onPointerDown}
        className={cx(handleCls, dragging ? draggingCls : undefined)}
      />
    </div>
  )
}

const handleCls = css({
  position: 'absolute',
  top: 0,
  right: '-3px',
  width: '6px',
  height: '100%',
  cursor: 'col-resize',
  zIndex: 5,
  _hover: { '&::after': { backgroundColor: 'primary.500' } },
  '&::after': {
    content: '""',
    position: 'absolute',
    top: 0,
    right: '3px',
    width: '2px',
    height: '100%',
    backgroundColor: 'transparent',
    transition: 'background-color 0.15s',
  },
})

const draggingCls = css({ '&::after': { backgroundColor: 'primary.500' } })
