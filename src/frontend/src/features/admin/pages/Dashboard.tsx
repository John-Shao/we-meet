import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'

import { fetchAdminStatsOverview } from '../api/adminStats'
import { TrendBarChart } from '../components/TrendBarChart'

export const AdminDashboard = () => {
  const { t } = useTranslation('admin')
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'stats', 'overview'],
    queryFn: fetchAdminStatsOverview,
    staleTime: 60_000,
  })

  if (isLoading || !data) {
    return (
      <div className={css({ padding: '1.5rem' })}>
        <h1 className={pageTitle}>{t('dashboard.title')}</h1>
        <p className={css({ color: 'greyscale.500', fontSize: '0.9375rem' })}>
          {t('dashboard.loading')}
        </p>
      </div>
    )
  }

  const cards: { label: string; value: number; accent?: boolean }[] = [
    {
      label: t('dashboard.membersActive'),
      value: data.members.active,
      accent: true,
    },
    { label: t('dashboard.membersTotal'), value: data.members.total },
    { label: t('dashboard.membersInvited'), value: data.members.invited },
    { label: t('dashboard.membersSuspended'), value: data.members.suspended },
    { label: t('dashboard.departments'), value: data.departments },
    { label: t('dashboard.meetings'), value: data.meetings },
    { label: t('dashboard.summaries'), value: data.summaries },
    { label: t('dashboard.approvalsPending'), value: data.approvals.pending },
  ]

  const trendTotal = data.trend.reduce((sum, p) => sum + p.count, 0)

  return (
    <div
      className={css({
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      })}
    >
      <h1 className={pageTitle}>{t('dashboard.title')}</h1>

      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: '0.875rem',
        })}
      >
        {cards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={c.value}
            accent={c.accent}
          />
        ))}
      </div>

      <section
        className={css({
          border: '1px solid token(colors.greyscale.200)',
          borderRadius: '10px',
          backgroundColor: 'greyscale.000',
          padding: '1.25rem',
        })}
      >
        <div
          className={css({
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: '0.75rem',
          })}
        >
          <h2
            className={css({
              fontSize: '0.9375rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('dashboard.trendTitle')}
          </h2>
          <span
            className={css({ fontSize: '0.8125rem', color: 'greyscale.500' })}
          >
            {t('dashboard.trendTotal', { count: trendTotal })}
          </span>
        </div>
        <TrendBarChart data={data.trend} />
        <div
          className={css({
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '0.375rem',
            fontSize: '0.6875rem',
            color: 'greyscale.400',
          })}
        >
          <span>{data.trend[0]?.date}</span>
          <span>{data.trend[data.trend.length - 1]?.date}</span>
        </div>
      </section>
    </div>
  )
}

const StatCard = ({
  label,
  value,
  accent,
}: {
  label: ReactNode
  value: number
  accent?: boolean
}) => (
  <div
    className={css({
      border: '1px solid token(colors.greyscale.200)',
      borderRadius: '10px',
      backgroundColor: 'greyscale.000',
      padding: '1rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.375rem',
    })}
  >
    <span className={css({ fontSize: '0.8125rem', color: 'greyscale.500' })}>
      {label}
    </span>
    <span
      className={`${css({ fontSize: '1.75rem', fontWeight: 'bold', lineHeight: 1 })} ${
        accent ? accentColor : neutralColor
      }`}
    >
      {value}
    </span>
  </div>
)

const pageTitle = css({
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const accentColor = css({ color: 'primary.600' })
const neutralColor = css({ color: 'greyscale.900' })
