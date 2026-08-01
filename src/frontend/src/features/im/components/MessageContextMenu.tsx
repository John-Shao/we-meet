import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RiAddLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { EmojiPicker } from './EmojiPicker'

export interface ContextMenuItem {
  key: string
  label: string
  onSelect: () => void
  /** Render in the danger colour (e.g. 撤回 / 删除). */
  danger?: boolean
}

interface Props {
  /** Cursor coordinates (clientX/clientY) where the menu should anchor. */
  x: number
  y: number
  items: ContextMenuItem[]
  /** Optional quick-reaction emoji bar shown above the items. */
  reactionEmojis?: string[]
  onReact?: (emoji: string) => void
  onClose: () => void
}

/**
 * Right-click context menu for chat messages (飞书式). Anchors at the cursor,
 * clamps inside the viewport, and closes on outside click / scroll / Esc.
 * Stateless about WHAT the items do — the caller builds them per message.
 */
export const MessageContextMenu = ({
  x,
  y,
  items,
  reactionEmojis,
  onReact,
  onClose,
}: Props) => {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [showPicker, setShowPicker] = useState(false)

  // Clamp inside the viewport once measured.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (x + r.width > window.innerWidth - 8) nx = window.innerWidth - r.width - 8
    if (y + r.height > window.innerHeight - 8) ny = window.innerHeight - r.height - 8
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) })
    // Re-clamp when switching into the (taller/wider) emoji picker.
  }, [x, y, showPicker])

  // Any outside interaction dismisses the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Ignore scrolls that originate INSIDE the menu (e.g. the emoji grid).
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) {
        return
      }
      onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      // Stop the mousedown from bubbling to the window dismiss handler so the
      // click can land on a menu item.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className={css({
        position: 'fixed',
        zIndex: 'modal',
        minWidth: '140px',
        backgroundColor: 'greyscale.000',
        border: '1px solid token(colors.greyscale.200)',
        borderRadius: '0.5rem',
        boxShadow: 'overlay',
        padding: '0.25rem',
      })}
      style={{ left: pos.x, top: pos.y }}
    >
      {showPicker ? (
        <EmojiPicker
          onPick={(emoji) => {
            onReact?.(emoji)
            onClose()
          }}
        />
      ) : (
        <>
          {reactionEmojis && reactionEmojis.length > 0 && (
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.125rem',
                paddingX: '0.25rem',
                paddingY: '0.125rem',
                marginBottom: items.length > 0 ? '0.25rem' : 0,
                borderBottom:
                  items.length > 0
                    ? '1px solid token(colors.greyscale.100)'
                    : 'none',
              })}
            >
              {reactionEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    onReact?.(emoji)
                    onClose()
                  }}
                  data-testid={`ctx-react-${emoji}`}
                  className={css({
                    border: 'none',
                    background: 'transparent',
                    borderRadius: '0.375rem',
                    fontSize: '1.125rem',
                    lineHeight: 1,
                    paddingX: '0.25rem',
                    paddingY: '0.1875rem',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.100' },
                  })}
                >
                  {emoji}
                </button>
              ))}
              {/* 「+」打开完整 emoji 面板 */}
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                aria-label="more emojis"
                data-testid="ctx-react-more"
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: '0.375rem',
                  color: 'greyscale.500',
                  paddingX: '0.25rem',
                  paddingY: '0.1875rem',
                  cursor: 'pointer',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                <RiAddLine size={18} />
              </button>
            </div>
          )}
          {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          onClick={() => {
            it.onSelect()
            onClose()
          }}
          data-testid={`msg-ctx-${it.key}`}
          className={css({
            display: 'block',
            width: '100%',
            textAlign: 'left',
            paddingX: '0.625rem',
            paddingY: '0.4375rem',
            border: 'none',
            background: 'transparent',
            borderRadius: '0.375rem',
            fontSize: '0.875rem',
            cursor: 'pointer',
            color: it.danger ? 'danger.500' : 'greyscale.800',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          {it.label}
        </button>
          ))}
        </>
      )}
    </div>
  )
}
