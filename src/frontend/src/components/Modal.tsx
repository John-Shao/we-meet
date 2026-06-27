import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

import { css } from '@/styled-system/css'

/** Keep Tab focus inside the dialog — a basic focus trap for the modal. */
const trapFocus = (e: KeyboardEvent, container: HTMLElement | null) => {
  if (!container) return
  const focusable = container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

interface Props {
  onClose: () => void
  /** Accessible name for the dialog. */
  ariaLabel: string
  /** Focused on open; falls back to the dialog container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>
  maxWidth?: string
  maxHeight?: string
  children: ReactNode
}

/**
 * Centered modal dialog over a dismissable backdrop. Owns the shared behaviour
 * every dialog needs: backdrop-click + Escape to close, a Tab focus trap, and
 * restoring focus to the trigger on close. Callers provide only the content.
 */
export const Modal = ({
  onClose,
  ariaLabel,
  initialFocusRef,
  maxWidth = '480px',
  maxHeight = '80vh',
  children,
}: Props) => {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Hold the latest onClose so the keydown effect can run once (deps [])
  // without re-subscribing every time the parent passes a fresh callback.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    ;(initialFocusRef?.current ?? dialogRef.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab') trapFocus(e, dialogRef.current)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previouslyFocused?.focus?.()
    }
  }, [initialFocusRef])

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current()
      }}
      className={css({
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        padding: '1rem',
      })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        style={{ maxWidth, maxHeight }}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          backgroundColor: 'white',
          borderRadius: '0.75rem',
          overflow: 'hidden',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
        })}
      >
        {children}
      </div>
    </div>
  )
}
