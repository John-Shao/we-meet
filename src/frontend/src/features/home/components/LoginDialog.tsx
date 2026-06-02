import { useTranslation } from 'react-i18next'
import { Dialog } from '@/primitives'
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
 *
 * Layout notes (matches Douyin's reference modal):
 * - Centered title + subtitle at the top.
 * - Two columns share the same horizontal baseline; the vertical divider
 *   stretches between them; column headings are centered above each
 *   panel so QR/OTP visually pair with their label.
 * - Column items are top-aligned (alignItems: 'flex-start') so the OTP
 *   form doesn't float to the middle of the much taller QR column.
 */
export const LoginDialog = () => {
  const { t } = useTranslation('home')
  const closeDialog = useCloseDialog()
  const handleSuccess = () => closeDialog?.()

  // type='flex' bypasses the primitive's hard-coded 30rem Box width, which
  // would clip the 200px QR plus the OTP form. The dialog body sets its
  // own width below.
  return (
    <Dialog type="flex">
      <div
        className={css({
          width: { base: '100%', xsm: '38rem' },
          maxWidth: '100%',
        })}
      >
      <div
        className={css({
          textAlign: 'center',
          marginBottom: '1.5rem',
        })}
      >
        <h1
          className={css({
            fontSize: '1.5rem',
            fontWeight: 700,
            marginBottom: '0.5rem',
          })}
        >
          {t('loginDialog.title')}
        </h1>
        <p
          className={css({
            fontSize: '0.875rem',
            color: 'greyscale.700',
          })}
        >
          {t('loginDialog.subtitle')}
        </p>
      </div>
      <div
        className={css({
          display: 'flex',
          gap: 2,
          flexDirection: { base: 'column', xsm: 'row' },
          alignItems: { base: 'center', xsm: 'flex-start' },
          justifyContent: 'center',
        })}
      >
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.75,
            flex: { xsm: '1 1 0' },
            maxWidth: '20rem',
          })}
        >
          <h2
            className={css({
              fontSize: '1rem',
              fontWeight: 600,
            })}
          >
            {t('loginPanels.qrTitle')}
          </h2>
          <QrLoginPanel onSuccess={handleSuccess} />
        </div>
        <div
          className={css({
            width: '1px',
            alignSelf: 'stretch',
            backgroundColor: 'greyscale.300',
            display: { base: 'none', xsm: 'block' },
          })}
          aria-hidden
        />
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
            flex: { xsm: '1 1 0' },
            minWidth: { xsm: '18rem' },
            width: '100%',
            maxWidth: '22rem',
          })}
        >
          <h2
            className={css({
              fontSize: '1rem',
              fontWeight: 600,
              textAlign: 'center',
            })}
          >
            {t('loginPanels.phoneTitle')}
          </h2>
          <PhoneLoginPanel onSuccess={handleSuccess} />
        </div>
      </div>
      </div>
    </Dialog>
  )
}
