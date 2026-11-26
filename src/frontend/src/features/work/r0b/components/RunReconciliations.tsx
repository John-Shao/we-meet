import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { useWorkBootstrap } from '../../r0a/api/queries'
import { muted, sectionTitle } from '../../r0a/ui'
import { useWorkRunReconciliations } from '../api/queries'

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
 * J16's "the user can see what is waiting" projection. It renders only when the org
 * advertises R0b and the run actually has an unknown/unresolved operation, so a normal
 * run does not grow an empty section. The read is cookie-plane and owner-scoped server
 * side; it carries metadata only, never operation arguments or provider text.
 */
export const RunReconciliations = ({
  runId,
  onContinue,
  onEndRun,
  endingRun = false,
}: {
  runId: string | null | undefined
  onContinue?: () => void
  onEndRun?: () => void
  endingRun?: boolean
}) => {
  const { t } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()
  const enabled = !!bootstrapQ.data?.phases.includes('R0b')
  const reconciliationsQ = useWorkRunReconciliations(
    runId ?? undefined,
    enabled
  )
  const data = reconciliationsQ.data
  const showInputActions =
    data?.wait_reason === 'input' &&
    data.items.some((entry) =>
      ['downgraded_readonly', 'evidence_exhausted'].includes(
        entry.resolution_state
      )
    )

  if (!enabled || !runId || !data || data.items.length === 0) return null

  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      aria-labelledby="work-run-reconciliations"
    >
      <h2 id="work-run-reconciliations" className={sectionTitle}>
        {t('task.reconciliations')}
      </h2>
      {data.blocking.new_run || data.blocking.acceptance ? (
        <p className={muted}>
          {[
            data.blocking.new_run ? t('task.reconciliationsBlockNewRun') : null,
            data.blocking.acceptance
              ? t('task.reconciliationsBlockAcceptance')
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {showInputActions ? (
        <div
          role="group"
          aria-label={t('task.reconciliationsInputTitle')}
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
            padding: 'md',
            border: '1px solid token(colors.border.subtle)',
          })}
        >
          <strong>{t('task.reconciliationsInputTitle')}</strong>
          <p className={muted}>
            {t(
              data.blocking.acceptance
                ? 'task.reconciliationsInputExhausted'
                : 'task.reconciliationsInputReadonly'
            )}
          </p>
          <div
            className={css({ display: 'flex', gap: 'sm', flexWrap: 'wrap' })}
          >
            {onContinue ? (
              <Button variant="secondary" size="dense" onPress={onContinue}>
                {t('task.reconciliationsContinue')}
              </Button>
            ) : null}
            <Link href="/work">
              <Button variant="secondary" size="dense">
                {t('task.reconciliationsNewRun')}
              </Button>
            </Link>
            {onEndRun ? (
              <Button
                variant="secondary"
                size="dense"
                loading={endingRun}
                onPress={onEndRun}
              >
                {t('task.reconciliationsEndRun')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ul className={list}>
        {data.items.map((entry) => (
          <li key={entry.operation_id} className={item}>
            <span className={keyName}>{entry.kind}</span>
            <span className={muted}>
              {t(`operationState.${entry.operation_state}`, {
                defaultValue: entry.operation_state,
              })}
            </span>
            <span className={muted}>
              {entry.waited_seconds === null
                ? t('task.reconciliationsNoClock')
                : t('task.reconciliationsWaited', {
                    seconds: entry.waited_seconds,
                  })}
            </span>
            <span>
              {t(`task.reconciliationsState.${entry.resolution_state}`)}
            </span>
            <span className={muted}>
              {entry.has_authoritative_evidence
                ? t('task.reconciliationsAuthority')
                : t('task.reconciliationsNoAuthority')}
            </span>
            <span className={muted}>
              {entry.evidence_sources.length > 0
                ? t('task.reconciliationsEvidence', {
                    sources: entry.evidence_sources.join(', '),
                  })
                : t('task.reconciliationsNoEvidence')}
            </span>
            {entry.ticket_id ? (
              <span className={muted}>
                {t('task.reconciliationsTicket', { ticket: entry.ticket_id })}
              </span>
            ) : null}
            <span className={muted}>
              {t(`task.reconciliationsContact.${entry.contact_path}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
