import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'

import { WorkApiError } from '../../r0a/api/client'
import { useWorkBootstrap } from '../../r0a/api/queries'
import { useReadOnlyViewport } from '../../r0a/hooks/useReadOnlyViewport'
import { errorText, muted, sectionTitle } from '../../r0a/ui'
import {
  useRevokeWorkReadonlyGrant,
  useWorkReadonlyGrants,
} from '../api/queries'
import type { WorkReadonlyGrant } from '../api/types'

const list = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
})

const item = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 'sm',
  paddingY: 'xs',
  borderTop: '1px solid token(colors.border.subtle)',
  textStyle: 'bodyMedium',
})

const keyName = css({ fontWeight: 'semibold' })

/**
 * §1.4 row 70's management face (0042:2518-2619): the owner reviews and revokes the
 * "same-kind readonly" grants that exempt a matching action from approval. The read is
 * run-scoped and owner-only server side, and expired/revoked rows stay listed because the
 * audit question outlives the grant (0042:2513-2517). Revoking does not cancel actions
 * already dispatched - those are reconciled - so the button says revoke, not cancel.
 */
export const RunReadonlyGrants = ({
  runId,
}: {
  runId: string | null | undefined
}) => {
  const { t, i18n } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()
  const enabled = !!bootstrapQ.data?.phases.includes('R0b')
  const grantsQ = useWorkReadonlyGrants(runId ?? undefined, enabled)
  const revoke = useRevokeWorkReadonlyGrant()
  const readOnly = useReadOnlyViewport()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const data = grantsQ.data
  if (!enabled || !runId || !data || data.grants.length === 0) return null

  const onRevoke = async (grant: WorkReadonlyGrant) => {
    setFailure(null)
    setStatus(null)
    setConfirming(null)
    try {
      await revoke.mutateAsync({
        grantId: grant.id,
        body: {
          client_request_id: crypto.randomUUID(),
          expected_revision: grant.revision,
        },
      })
      setStatus(t('task.readonlyGrantsRevoked'))
    } catch (error) {
      const code = error instanceof WorkApiError ? error.code : ''
      // A stale revision or a grant that is no longer active means the owner's view is
      // out of date; the honest recovery is to re-read, not to retry the same CAS.
      if (
        code === 'idempotency_key_conflict' ||
        code.startsWith('invalid_transition')
      ) {
        setFailure(t('task.readonlyGrantsConflict'))
        void grantsQ.refetch()
        return
      }
      setFailure(t('task.readonlyGrantsFailed'))
    }
  }

  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      aria-labelledby="work-run-readonly-grants"
    >
      <h2 id="work-run-readonly-grants" className={sectionTitle}>
        {t('task.readonlyGrants')}
      </h2>
      {status ? <p role="status">{status}</p> : null}
      {failure ? (
        <p className={errorText} role="alert">
          {failure}
        </p>
      ) : null}
      <ul className={list}>
        {data.grants.map((grant) => (
          <li key={grant.id} className={item}>
            <span className={keyName}>{grant.tool_set.join(', ')}</span>
            <span>{t(`task.readonlyGrantsState.${grant.status}`)}</span>
            <span className={muted}>
              {t('task.readonlyGrantsExpires', {
                time: new Date(grant.expires_at).toLocaleString(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </span>
            <span className={muted}>
              {t('task.readonlyGrantsConsumed', {
                times: grant.consumed_count,
              })}
            </span>
            {grant.status === 'active' && !readOnly ? (
              confirming === grant.id ? (
                <>
                  <Button
                    variant="secondary"
                    size="dense"
                    loading={revoke.isPending}
                    onPress={() => void onRevoke(grant)}
                  >
                    {t('task.readonlyGrantsConfirmRevoke')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="dense"
                    onPress={() => setConfirming(null)}
                  >
                    {t('task.readonlyGrantsCancel')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={() => setConfirming(grant.id)}
                >
                  {t('task.readonlyGrantsRevoke')}
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
