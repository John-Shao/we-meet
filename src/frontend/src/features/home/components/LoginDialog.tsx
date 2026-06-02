import { useTranslation } from 'react-i18next'
import { Dialog, H } from '@/primitives'
import { QrLoginPanel, PhoneLoginPanel } from '@/features/auth'
import { useCloseDialog } from '@/primitives/useCloseDialog'
import { css } from '@/styled-system/css'

/**
 * Douyin-style login dialog: QR on the left, phone OTP on the right.
 *
 * Used from the logged-out home page where the entry points are now
 * `[Login] [Join meeting]` — anonymous join still works for public rooms,
 * so the login panel only opens when the user clicks Login.
 *
 * Both inner panels receive `onSuccess` so that the moment tokens land in
 * localStorage and the user query is invalidated, the dialog closes and
 * the home page re-renders in its logged-in state.
 */
export const LoginDialog = () => {
  const { t } = useTranslation('home')
  const closeDialog = useCloseDialog()
  const handleSuccess = () => closeDialog?.()

  return (
    <Dialog title={t('loginDialog.title')}>
      <div
        className={css({
          display: 'flex',
          gap: 1.5,
          flexDirection: { base: 'column', xsm: 'row' },
          alignItems: { base: 'center', xsm: 'flex-start' },
          marginTop: '0.5rem',
        })}
      >
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.5,
          })}
        >
          <H lvl={2} margin={false}>
            {t('loginPanels.qrTitle')}
          </H>
          <QrLoginPanel onSuccess={handleSuccess} />
        </div>
        <div
          className={css({
            width: '1px',
            alignSelf: 'stretch',
            backgroundColor: 'greyscale.500',
            display: { base: 'none', xsm: 'block' },
          })}
          aria-hidden
        />
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            minWidth: { xsm: '18rem' },
            width: '100%',
            maxWidth: '22rem',
          })}
        >
          <H lvl={2} margin={false}>
            {t('loginPanels.phoneTitle')}
          </H>
          <PhoneLoginPanel onSuccess={handleSuccess} />
        </div>
      </div>
    </Dialog>
  )
}
