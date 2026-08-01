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

/**
 * 打开中的 Modal 栈(按挂载顺序)。Escape / Tab 都挂在 document 上,嵌套时
 * 每一层都会收到同一个事件 —— 不分层的话在内层按 Esc 会把外层一起关掉
 * (例:新建日程里开「批量添加」,一个 Esc 连表单都没了)。只让栈顶响应。
 */
const modalStack: symbol[] = []

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
    const token = Symbol('modal')
    modalStack.push(token)
    const onKey = (e: KeyboardEvent) => {
      // 嵌套时只有最上层那个响应键盘(见 modalStack 注释)。
      if (modalStack[modalStack.length - 1] !== token) return
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab') trapFocus(e, dialogRef.current)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = modalStack.indexOf(token)
      if (i !== -1) modalStack.splice(i, 1)
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
          backgroundColor: 'greyscale.000',
          borderRadius: '0.75rem',
          overflow: 'hidden',
          // modal 档在深色下带 1px 白色内描边:本体底色是 greyscale.000,
          // 深色下与页面同为 #161616,只靠黑投影是分不出边界的。
          boxShadow: 'modal',
        })}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * 对话框标题栏右上角的关闭 ✕。
 *
 * 原先 6 个对话框各自 `const closeBtn = css({...})` 配同一段 5 行 markup,
 * 字节级完全相同(日程新建/批量加人/加群成员/群语音/会议邀请/星标添加),
 * 唯一的变量是无障碍名 —— 各自命名空间下的「取消」。收成一个组件,新对话框
 * 直接用,别再抄第七份。
 *
 * 样式与原先逐字一致(含「没有 hover 态」),这一步只做去重不改外观。
 */
export const ModalCloseButton = ({
  onClose,
  label,
}: {
  onClose: () => void
  /** 无障碍名(✕ 字形本身读不出意思)。 */
  label: string
}) => (
  <button
    type="button"
    onClick={onClose}
    aria-label={label}
    className={css({
      border: 'none',
      background: 'transparent',
      fontSize: '1.25rem',
      lineHeight: 1,
      cursor: 'pointer',
      color: 'greyscale.600',
    })}
  >
    ×
  </button>
)
