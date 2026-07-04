import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { RequireAuth } from '@/components/RequireAuth'

import { useAdminMe } from './hooks/useAdminMe'

/**
 * Gate for the management console (M 端). `RequireAuth` handles the not-logged-in
 * case (→ login landing); this layer additionally requires the caller to be an
 * organization administrator/owner (`is_org_admin`, resolved server-side from
 * their `Membership.org_role`). Non-admins get a 403 screen, never the console.
 *
 * The UI check mirrors the backend `IsOrgAdmin` guard on every admin mutation —
 * it is convenience, not the security boundary.
 */
export const AdminGuard = ({ children }: { children: ReactNode }) => (
  <RequireAuth>
    <AdminGuardInner>{children}</AdminGuardInner>
  </RequireAuth>
)

const AdminGuardInner = ({ children }: { children: ReactNode }) => {
  const { data, isLoading } = useAdminMe()

  // Still resolving the caller's role — render nothing to avoid a 403 flash.
  if (isLoading) return null
  if (!data?.is_org_admin) return <AdminForbidden />
  return <>{children}</>
}

const AdminForbidden = () => {
  const { t } = useTranslation('admin')
  return (
    <div
      className={css({
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
        backgroundColor: 'greyscale.000',
        color: 'default.text',
      })}
    >
      <h1 className={css({ fontSize: '1.5rem', fontWeight: 'bold' })}>
        {t('forbidden.title')}
      </h1>
      <p className={css({ color: 'greyscale.600', maxWidth: '28rem' })}>
        {t('forbidden.description')}
      </p>
      <a
        href="/"
        className={css({
          color: 'primary.600',
          textDecoration: 'underline',
          fontSize: '0.9375rem',
        })}
      >
        {t('forbidden.back')}
      </a>
    </div>
  )
}
