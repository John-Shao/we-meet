import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

/**
 * App-wide styled confirm / alert dialogs, Promise-based, replacing native
 * `window.confirm` / `window.alert` (jarring against the Feishu-style UI).
 *
 *   const { confirm, alert } = useConfirm()
 *   if (!(await confirm({ message, danger: true }))) return
 *   await alert({ message })   // styled error/notice
 *
 * Reuses the react-aria `Dialog` primitive (a11y + animation). The provider is
 * mounted once at the app root; any descendant can call useConfirm().
 */

interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Use the destructive (red) confirm button — for kick / leave / clear. */
  danger?: boolean
}

interface AlertOptions {
  title?: string
  message: string
  okLabel?: string
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  alert: (opts: AlertOptions) => Promise<void>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

type Pending =
  | { mode: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { mode: 'alert'; opts: AlertOptions; resolve: () => void }

export const ConfirmProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation('shell')
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setPending({ mode: 'confirm', opts, resolve })
      ),
    []
  )
  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) =>
        setPending({ mode: 'alert', opts, resolve })
      ),
    []
  )

  // Resolve the pending promise (confirm → boolean; alert → void) and close.
  const settle = useCallback((result: boolean) => {
    setPending((p) => {
      if (!p) return null
      if (p.mode === 'confirm') p.resolve(result)
      else p.resolve()
      return null
    })
  }, [])

  const confirmOpts = pending?.mode === 'confirm' ? pending.opts : null
  const alertOpts = pending?.mode === 'alert' ? pending.opts : null

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      <Dialog
        isOpen={pending !== null}
        title={pending?.opts.title}
        onOpenChange={(open) => {
          // Esc / overlay / close-X dismiss == cancel (alert resolves void).
          if (!open) settle(false)
        }}
      >
        <p
          className={css({
            marginBottom: '1.25rem',
            color: 'greyscale.700',
            fontSize: '0.9375rem',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            maxWidth: '22rem',
          })}
        >
          {pending?.opts.message}
        </p>
        <div
          className={css({
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
          })}
        >
          {confirmOpts && (
            <Button variant="secondary" size="sm" onPress={() => settle(false)}>
              {confirmOpts.cancelLabel ?? t('cancel')}
            </Button>
          )}
          <Button
            variant={confirmOpts?.danger ? 'danger' : 'primary'}
            size="sm"
            onPress={() => settle(true)}
          >
            {confirmOpts
              ? (confirmOpts.confirmLabel ?? t('confirm'))
              : (alertOpts?.okLabel ?? t('ok'))}
          </Button>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- provider + its hook are intentionally colocated
export const useConfirm = (): ConfirmContextValue => {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm must be used within <ConfirmProvider>')
  }
  return ctx
}
