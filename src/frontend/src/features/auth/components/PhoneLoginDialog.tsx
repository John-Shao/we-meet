import { useTranslation } from 'react-i18next'
import { Dialog, useCloseDialog } from '@/primitives'
import { PhoneLoginPanel } from './PhoneLoginPanel'

/**
 * Modal wrapper around PhoneLoginPanel, kept for legacy call sites that want
 * a dialog form factor (Header / Settings / Recording deep-link prompts).
 * The home page uses PhoneLoginPanel directly in the dual-pane login layout.
 */
export const PhoneLoginDialog = () => {
  const { t } = useTranslation('global', { keyPrefix: 'phoneLogin' })
  const close = useCloseDialog()
  return (
    <Dialog title={t('title')}>
      <PhoneLoginPanel
        onSuccess={() => close?.()}
        onCancel={() => close?.()}
      />
    </Dialog>
  )
}
