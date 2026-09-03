import { useTranslation } from 'react-i18next'

import { StateHint } from '@/components/StateHint'
import { MemberAvatar } from '@/features/contacts'
import { css } from '@/styled-system/css'

import { useTaskStatistics } from '../api/fetchTasks'
import type { TaskWorkspaceState } from '../taskWorkspaceState'

export const TaskAnalytics = ({ state }: { state: TaskWorkspaceState }) => {
  const { t } = useTranslation('tasks')
  const { data, isLoading, error } = useTaskStatistics(
    state.scope,
    state.time,
    state.priority,
    state.taskList,
    state.group
  )

  if (isLoading) return <StateHint loading>{t('analytics.loading')}</StateHint>
  if (error || !data) return <StateHint>{t('analytics.error')}</StateHint>

  const cards = [
    ['total', data.summary.total],
    ['open', data.summary.open],
    ['completed', data.summary.completed],
    ['overdue', data.summary.overdue],
  ] as const

  return (
    <div className={analyticsCss}>
      <section className={summaryGridCss} aria-label={t('analytics.summary')}>
        {cards.map(([key, value]) => (
          <article key={key} className={summaryCardCss} data-kind={key}>
            <span>{t(`analytics.cards.${key}`)}</span>
            <strong>{value}</strong>
          </article>
        ))}
        <article className={completionCardCss}>
          <div>
            <span>{t('analytics.cards.completionRate')}</span>
            <strong>{data.summary.completion_rate}%</strong>
          </div>
          <Progress value={data.summary.completion_rate} />
        </article>
      </section>

      <div className={analyticsColumnsCss}>
        <section className={panelCss}>
          <header>
            <h2>{t('analytics.workload')}</h2>
            <span>{t('analytics.workloadHint')}</span>
          </header>
          {data.workload.length === 0 ? (
            <p className={emptyCss}>{t('analytics.empty')}</p>
          ) : (
            <div className={workloadListCss}>
              {data.workload.map((item) => {
                const name =
                  item.assignee__full_name ||
                  item.assignee__short_name ||
                  item.assignee__email ||
                  t('meta.none')
                const maxOpen = Math.max(
                  1,
                  ...data.workload.map((entry) => entry.open)
                )
                return (
                  <article key={item.assignee_id} className={workloadRowCss}>
                    <MemberAvatar
                      name={name}
                      src={item.assignee__avatar_url}
                      size="2rem"
                    />
                    <div className={workloadContentCss}>
                      <div>
                        <strong>{name}</strong>
                        <span>
                          {t('analytics.workloadMeta', {
                            open: item.open,
                            overdue: item.overdue,
                            completed: item.completed,
                          })}
                        </span>
                      </div>
                      <Progress value={(item.open / maxOpen) * 100} />
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className={panelCss}>
          <header>
            <h2>{t('analytics.groupProgress')}</h2>
            <span>{t('analytics.groupProgressHint')}</span>
          </header>
          {data.groups.length === 0 ? (
            <p className={emptyCss}>{t('analytics.empty')}</p>
          ) : (
            <div className={groupListCss}>
              {data.groups.map((group) => {
                const progress = group.total
                  ? Math.round((group.completed / group.total) * 100)
                  : 0
                return (
                  <article key={group.group_id || 'ungrouped'}>
                    <div>
                      <strong>
                        {group.group__name || t('groups.ungrouped')}
                      </strong>
                      <span>
                        {t('analytics.groupMeta', {
                          completed: group.completed,
                          total: group.total,
                        })}
                      </span>
                    </div>
                    <Progress value={progress} />
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

const Progress = ({ value }: { value: number }) => (
  <div
    className={progressTrackCss}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(value)}
  >
    <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
  </div>
)

const analyticsCss = css({
  minHeight: '100%',
  padding: '1rem',
  backgroundColor: 'greyscale.50',
})
const summaryGridCss = css({
  display: 'grid',
  gridTemplateColumns: {
    base: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(4, minmax(0, 1fr)) 2fr',
  },
  gap: '0.75rem',
})
const summaryCardCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  minHeight: '6rem',
  padding: '0.875rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '10px',
  backgroundColor: 'greyscale.000',
  '& span': { color: 'default.subtle-text', fontSize: '0.75rem' },
  '& strong': { fontSize: '1.75rem', fontWeight: '600' },
  '&[data-kind="overdue"] strong': { color: 'danger.600' },
})
const completionCardCss = css({
  gridColumn: { base: '1 / -1', lg: 'auto' },
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: '0.75rem',
  minHeight: '6rem',
  padding: '0.875rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '10px',
  backgroundColor: 'greyscale.000',
  '& > div:first-child': {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
  },
  '& span': { color: 'default.subtle-text', fontSize: '0.75rem' },
  '& strong': { fontSize: '1.25rem' },
})
const analyticsColumnsCss = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 1.4fr) minmax(0, 1fr)' },
  gap: '0.75rem',
  marginTop: '0.75rem',
})
const panelCss = css({
  minWidth: 0,
  padding: '1rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '10px',
  backgroundColor: 'greyscale.000',
  '& > header': { marginBottom: '1rem' },
  '& h2': { margin: 0, fontSize: '0.9375rem' },
  '& header span': { color: 'default.subtle-text', fontSize: '0.75rem' },
})
const workloadListCss = css({ display: 'flex', flexDirection: 'column' })
const workloadRowCss = css({
  display: 'grid',
  gridTemplateColumns: '2rem minmax(0, 1fr)',
  alignItems: 'center',
  gap: '0.75rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.100)',
})
const workloadContentCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  '& > div': {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  '& strong': { fontSize: '0.8125rem' },
  '& span': { color: 'default.subtle-text', fontSize: '0.6875rem' },
})
const groupListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
  '& article > div': {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
    marginBottom: '0.375rem',
  },
  '& strong': { fontSize: '0.8125rem' },
  '& span': { color: 'default.subtle-text', fontSize: '0.6875rem' },
})
const progressTrackCss = css({
  width: '100%',
  height: '0.375rem',
  overflow: 'hidden',
  borderRadius: '999px',
  backgroundColor: 'greyscale.200',
  '& span': {
    display: 'block',
    height: '100%',
    borderRadius: '999px',
    backgroundColor: 'primary.500',
  },
})
const emptyCss = css({
  margin: '2rem 0',
  color: 'default.subtle-text',
  fontSize: '0.8125rem',
  textAlign: 'center',
})
