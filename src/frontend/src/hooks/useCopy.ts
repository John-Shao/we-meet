import { useCallback, useEffect, useRef, useState } from 'react'

import { useConfirm } from '@/components/ConfirmProvider'

/**
 * Copy to the clipboard with a short-lived "copied" state, keyed so one hook
 * can drive several copy buttons on a page.
 *
 * Extracted from `features/admin/pages/Invites.tsx`, which is the closest of
 * the several hand-rolled copies. The others (meeting detail, event dialog,
 * room link) differ in what they do afterwards, so they are deliberately left
 * alone rather than bent into this shape.
 */
export const useCopy = (resetMs = 1600) => {
  const { alert: showAlert } = useConfirm()
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(
    async (key: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(key)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(
          () => setCopied((c) => (c === key ? null : c)),
          resetMs
        )
      } catch {
        // 剪贴板在非 https / 无权限时会拒绝。与其静默失败,不如把内容摊开
        // 让人自己选中复制。
        void showAlert({ message: value })
      }
    },
    [resetMs, showAlert]
  )

  return { copied, copy }
}
