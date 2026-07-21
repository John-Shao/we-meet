import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'

import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'

import {
  type AuditLogEntry,
  AUDIT_ACTIONS,
  actionI18nKey,
  fetchAuditLogs,
} from '../api/adminAudit'

const formatTime = (iso: string, locale: string) => {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export const AdminAudit = () => {
  const { t, i18n } = useTranslation('admin')

  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const params = {
    action,
    since: from ? `${from}T00:00:00` : undefined,
    until: to ? `${to}T23:59:59` : undefined,
    page,
  }

  const { data, isFetching } = useQuery({
    queryKey: ['admin', 'audit', params],
    queryFn: () => fetchAuditLogs(params),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })

  const logs = data?.results ?? []
  const actionLabel = (a: string) => t(actionI18nKey(a), { defaultValue: a })
  const actorLabel = (e: AuditLogEntry) =>
    e.actor ? e.actor.full_name || e.actor.short_name || '' : t('audit.systemActor')

  const resetPageThen = (fn: () => void) => {
    fn()
    setPage(1)
  }

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', height: '100%' })}>
      <div
        className={css({
          flexShrink: 0,
          paddingX: '1.25rem',
          paddingY: '0.875rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <h1 className={css({ fontSize: '1.125rem', fontWeight: 'bold', color: 'greyscale.900', marginBottom: '0.75rem' })}>
          {t('audit.title')}
        </h1>
        <div className={css({ display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'center' })}>
          <select
            value={action}
            onChange={(e) => resetPageThen(() => setAction(e.target.value))}
            className={cx(filterControl, selectChrome)}
          >
            <option value="">{t('audit.filterAllActions')}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
          <label className={dateLabel}>
            {t('audit.dateFrom')}
            <input
              type="date"
              value={from}
              onChange={(e) => resetPageThen(() => setFrom(e.target.value))}
              className={filterControl}
            />
          </label>
          <label className={dateLabel}>
            {t('audit.dateTo')}
            <input
              type="date"
              value={to}
              onChange={(e) => resetPageThen(() => setTo(e.target.value))}
              className={filterControl}
            />
          </label>
        </div>
      </div>

      <div className={css({ flex: 1, overflowY: 'auto' })}>
        {isFetching && logs.length === 0 ? (
          <p className={emptyText}>{t('audit.loading')}</p>
        ) : logs.length === 0 ? (
          <p className={emptyText}>{t('audit.noLogs')}</p>
        ) : (
          <table className={css({ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' })}>
            <thead>
              <tr className={css({ textAlign: 'left', color: 'greyscale.500', borderBottom: '1px solid token(colors.greyscale.200)' })}>
                <th className={th}>{t('audit.colTime')}</th>
                <th className={th}>{t('audit.colActor')}</th>
                <th className={th}>{t('audit.colAction')}</th>
                <th className={th}>{t('audit.colTarget')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((e) => (
                <tr
                  key={e.id}
                  className={css({
                    borderBottom: '1px solid token(colors.greyscale.100)',
                    _hover: { backgroundColor: 'greyscale.50' },
                  })}
                >
                  <td className={`${td} ${css({ whiteSpace: 'nowrap', color: 'greyscale.600' })}`}>
                    {formatTime(e.created_at, i18n.language)}
                  </td>
                  <td className={td}>{actorLabel(e)}</td>
                  <td className={td}>{actionLabel(e.action)}</td>
                  <td className={td}>
                    {e.target_label || e.target_id}
                    {e.target_type && (
                      <span className={css({ color: 'greyscale.400', fontSize: '0.8125rem' })}>
                        {' '}
                        ({e.target_type})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        className={css({
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '0.75rem',
          paddingX: '1.25rem',
          paddingY: '0.625rem',
          borderTop: '1px solid token(colors.greyscale.200)',
          fontSize: '0.8125rem',
          color: 'greyscale.600',
        })}
      >
        <span>{t('audit.total', { count: data?.count ?? 0 })}</span>
        <button
          type="button"
          disabled={!data?.previous}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className={pagerBtn}
        >
          {t('audit.prev')}
        </button>
        <button
          type="button"
          disabled={!data?.next}
          onClick={() => setPage((p) => p + 1)}
          className={pagerBtn}
        >
          {t('audit.next')}
        </button>
      </div>
    </div>
  )
}

const th = css({ paddingX: '1rem', paddingY: '0.625rem', fontWeight: '600' })
const td = css({ paddingX: '1rem', paddingY: '0.5rem', color: 'greyscale.800', verticalAlign: 'top' })
const emptyText = css({ padding: '1.5rem', color: 'greyscale.500', fontSize: '0.9375rem' })
const filterControl = css({
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.875rem',
})
const dateLabel = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})
const pagerBtn = css({
  padding: '0.25rem 0.625rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '4px',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.700',
  _hover: { backgroundColor: 'greyscale.100' },
  _disabled: { opacity: 0.4, cursor: 'default' },
})
