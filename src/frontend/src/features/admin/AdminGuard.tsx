import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Button, LinkButton } from '@/primitives'
import { PageState } from '@/components/PageState'
import { RequireAuth } from '@/components/RequireAuth'
import { StateHint } from '@/components/StateHint'

import { useAdminMe } from './hooks/useAdminMe'

/**
 * Gate for the management console (M 端). `RequireAuth` handles the not-logged-in
 * case (→ login landing); this layer additionally requires the caller to have
 * *some* administrative standing in their organization.
 *
 * P10 M2 widened that from "is an owner/administrator" to "holds at least one
 * permission". Keeping the old test would have made custom roles pointless: an
 * HR-role holder has real permissions server-side but would be bounced at the
 * door and never reach the pages those permissions unlock. Which page they can
 * actually open is decided by the nav filter and by each endpoint.
 *
 * The UI check mirrors the backend guards on every admin endpoint — it is
 * convenience, not the security boundary.
 */
export const AdminGuard = ({ children }: { children: ReactNode }) => (
  <RequireAuth>
    <AdminGuardInner>{children}</AdminGuardInner>
  </RequireAuth>
)

const AdminGuardInner = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation('admin')
  const { data, isLoading, isError, refetch } = useAdminMe()

  if (isLoading) {
    return (
      <div className={guardStateCls}>
        <StateHint state="loading">{t('dashboard.loading')}</StateHint>
      </div>
    )
  }
  if (isError) {
    return (
      <div className={guardStateCls}>
        <PageState
          state="error"
          description={t('feedback.loadFailed')}
          action={
            <Button
              variant="secondary"
              size="action"
              onPress={() => void refetch()}
            >
              {t('feedback.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  // `is_org_admin` first so an old backend (no `permissions` field) still admits
  // owners/administrators rather than locking everyone out of the console.
  const admitted = data?.is_org_admin || (data?.permissions?.length ?? 0) > 0
  if (!admitted) return <AdminForbidden />
  return <>{children}</>
}

const AdminForbidden = () => {
  const { t } = useTranslation('admin')
  return (
    <div className={guardStateCls}>
      <PageState
        title={t('forbidden.title')}
        description={t('forbidden.description')}
        action={
          <LinkButton href="/" variant="secondary" size="action">
            {t('forbidden.back')}
          </LinkButton>
        }
      />
    </div>
  )
}

const guardStateCls = css({
  width: '100%',
  height: '100%',
  minHeight: 0,
  display: 'grid',
  placeItems: 'center',
  padding: '2xl',
  backgroundColor: 'surface.default',
})
