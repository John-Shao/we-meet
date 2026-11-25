import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { useWorkBootstrap, useWorkRunOperations } from '../api/queries'
import type { WorkOperation } from '../api/types'
import { useWorkRunSupersedeBudgets } from '../../r0b/api/queries'
import type { RunSupersedeBudget } from '../../r0b/api/types'
import { muted, sectionTitle } from '../ui'

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

const stepKey = (logicalKey: string) => logicalKey.replace(/#\d+$/, '')

// D5 §5.3 puts the run's Operations in the same column as the timeline, with the
// tool steps folded: a run can issue many tool calls and the owner's question is
// "did the model step finish", not a scroll through every call. Model and
// artifact steps stay visible because each one is a decision point - a publish,
// a billing settlement, a provider round trip.
export const RunOperations = ({
  runId,
  runState,
  waitReason,
  onEndRun,
  endingRun = false,
}: {
  runId: string | null | undefined
  runState?: string
  waitReason?: string | null
  onEndRun?: () => void
  endingRun?: boolean
}) => {
  const { t } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()
  const operationsQ = useWorkRunOperations(runId ?? undefined)
  const budgetsQ = useWorkRunSupersedeBudgets(
    runId ?? undefined,
    !!bootstrapQ.data?.phases.includes('R0b')
  )
  const items = operationsQ.data?.pages.flatMap((page) => page.items) ?? []
  const budgets = new Map(
    budgetsQ.data?.steps.map((budget) => [budget.step_key, budget]) ?? []
  )
  const supersedeLimitReached =
    runState === 'waiting' &&
    waitReason === 'input' &&
    (budgetsQ.data?.steps.some((budget) => budget.limit_reached) ?? false)
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = operationsQ

  // D5 §5.3: the ledger is a read projection with no paging affordance in the
  // column, so the fold count and the "tool steps" grouping must describe the
  // whole run rather than the first page. Pull pages while one exists; each
  // completed fetch flips isFetchingNextPage back to false and re-runs this
  // effect until hasNextPage turns false. A failed page stops the loop instead
  // of retrying immediately - the cursor never advanced, so retrying here would
  // hammer the server forever.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError) return
    void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])

  if (!runId) return null

  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      aria-labelledby="work-run-operations"
    >
      <h2 id="work-run-operations" className={sectionTitle}>
        {t('task.operations')}
      </h2>
      {supersedeLimitReached ? (
        <div
          role="alert"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
            padding: 'md',
            border: '1px solid token(colors.border.subtle)',
          })}
        >
          <p className={muted}>{t('task.operations.supersedeLimit')}</p>
          <div
            className={css({ display: 'flex', gap: 'sm', flexWrap: 'wrap' })}
          >
            <Link href="/work">
              <Button variant="secondary" size="dense">
                {t('task.operations.repreview')}
              </Button>
            </Link>
            {onEndRun ? (
              <Button
                variant="secondary"
                size="dense"
                loading={endingRun}
                onPress={onEndRun}
              >
                {t('task.operations.endRun')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {operationsQ.isLoading ? (
        <p className={muted}>{t('loading')}</p>
      ) : operationsQ.isError ? (
        // The projection is secondary: a failed read says so in one line and
        // leaves the timeline and the artifact panel usable.
        <p className={muted}>{t('task.operationsUnavailable')}</p>
      ) : items.length === 0 ? (
        <p className={muted}>{t('task.operationsEmpty')}</p>
      ) : (
        <>
          <ul className={list}>
            {items
              .filter((operation) => operation.kind !== 'tool')
              .map((operation) => (
                <OperationRow
                  key={operation.id}
                  operation={operation}
                  budget={budgets.get(stepKey(operation.logical_key))}
                />
              ))}
          </ul>
          {items.some((operation) => operation.kind === 'tool') ? (
            <details
              className={css({
                borderTop: '1px solid token(colors.border.subtle)',
                paddingY: 'xs',
              })}
            >
              <summary className={muted}>
                {t('task.operations.toolSteps', {
                  count: items.filter((operation) => operation.kind === 'tool')
                    .length,
                })}
              </summary>
              <ul className={list}>
                {items
                  .filter((operation) => operation.kind === 'tool')
                  .map((operation) => (
                    <OperationRow
                      key={operation.id}
                      operation={operation}
                      budget={budgets.get(stepKey(operation.logical_key))}
                    />
                  ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}

// An Operation row is identity and status only. The read projection carries no
// arguments, no answer text and no receipt body, so there is nothing here that
// could leak task content even by accident.
const OperationRow = ({
  operation,
  budget,
}: {
  operation: WorkOperation
  budget?: RunSupersedeBudget
}) => {
  const { t } = useTranslation('work')
  return (
    <li className={item}>
      <span className={keyName}>{operation.logical_key}</span>
      <span className={muted}>
        {t(`operationState.${operation.state}`, {
          defaultValue: operation.state,
        })}
      </span>
      {budget && budget.supersede_no > 0 ? (
        <span className={muted}>
          {t('task.operations.supersedeTotal', {
            count: budget.supersede_no,
          })}
        </span>
      ) : null}
      {budget && budget.supersede_no > 0 ? (
        <span className={muted}>
          {t('task.operations.supersedeCount', {
            count: budget.active_supersede_count,
            limit: budget.active_supersede_limit,
          })}
        </span>
      ) : null}
      {operation.provider_request_id ? (
        <span className={muted}>
          {t('task.operations.provider', {
            id: operation.provider_request_id,
          })}
        </span>
      ) : null}
    </li>
  )
}
