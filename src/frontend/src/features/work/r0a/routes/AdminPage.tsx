import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives/Button'
import { PageState } from '@/components/PageState'
import { css } from '@/styled-system/css'
import {
  useAdminAuditExport,
  useAdminOverview,
  useAdminSeats,
  useCreateAdminAuditExport,
  useDownloadAdminAuditExport,
  useWorkBootstrap,
} from '../api/queries'
import { card, muted, page } from '../ui'

const dateInput = (daysAgo: number) => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

const asRange = (value: string, end: boolean) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (end) date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString()
}

export const AdminPage = () => {
  const { t } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()
  const overviewQ = useAdminOverview()
  const seatsQ = useAdminSeats()
  const createExport = useCreateAdminAuditExport()
  const downloadExport = useDownloadAdminAuditExport()
  const [rangeFrom, setRangeFrom] = useState(dateInput(7))
  const [rangeTo, setRangeTo] = useState(dateInput(1))
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [exportId, setExportId] = useState<string>()
  const exportQ = useAdminAuditExport(exportId)

  if (bootstrapQ.isLoading) return <p className={muted}>{t('loading')}</p>
  if (bootstrapQ.isError) {
    return (
      <PageState
        state="error"
        title={t('errors.bootstrapTitle')}
        description={t('errors.bootstrapDescription')}
      />
    )
  }
  if (!bootstrapQ.data) return <p className={muted}>{t('loading')}</p>
  const role = bootstrapQ.data.org.role
  if (role !== 'owner' && role !== 'admin') {
    return (
      <PageState
        state="empty"
        title={t('admin.forbiddenTitle')}
        description={t('admin.forbiddenDescription')}
      />
    )
  }
  const overview = overviewQ.data
  const seats = seatsQ.data?.pages.flatMap((item) => item.items) ?? []

  return (
    <div className={page}>
      <div
        className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      >
        <h1 className={css({ margin: 0, textStyle: 'titleLarge' })}>
          {t('admin.title')}
        </h1>
        <p className={muted}>{t('admin.subtitle')}</p>
      </div>

      {overviewQ.isLoading ? (
        <p className={muted}>{t('loading')}</p>
      ) : overviewQ.isError ? (
        <PageState
          state="error"
          title={t('admin.overviewError')}
          action={
            <Button
              variant="secondary"
              size="dense"
              onPress={() => overviewQ.refetch()}
            >
              {t('retry')}
            </Button>
          }
        />
      ) : overview ? (
        <section className={card}>
          <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
            {t('admin.overview')}
          </h2>
          <dl
            className={css({
              display: 'grid',
              gridTemplateColumns: { base: '1fr', md: 'repeat(3, 1fr)' },
              gap: 'md',
              margin: 0,
            })}
          >
            <div>
              <dt className={muted}>{t('admin.organization')}</dt>
              <dd className={css({ margin: 0 })}>
                {overview.name ?? overview.org_id}
              </dd>
            </div>
            <div>
              <dt className={muted}>{t('admin.seatsLabel')}</dt>
              <dd className={css({ margin: 0 })}>
                {overview.seats.active} / {overview.seats.total}
              </dd>
            </div>
            <div>
              <dt className={muted}>{t('admin.quota')}</dt>
              <dd className={css({ margin: 0 })}>
                {overview.quota.settled_tokens.toLocaleString()} /{' '}
                {overview.quota.limit_tokens.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className={muted}>{t('admin.reserved')}</dt>
              <dd className={css({ margin: 0 })}>
                {overview.quota.reserved_tokens.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className={muted}>{t('admin.enforcement')}</dt>
              <dd className={css({ margin: 0 })}>
                {overview.quota.enforcement}
              </dd>
            </div>
            <div>
              <dt className={muted}>{t('admin.retention')}</dt>
              <dd className={css({ margin: 0 })}>
                {overview.audit_retention_days} {t('admin.days')}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <section className={card}>
        <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
          {t('admin.seats')}
        </h2>
        {seatsQ.isLoading ? (
          <p className={muted}>{t('loading')}</p>
        ) : seatsQ.isError ? (
          <p className={muted}>{t('admin.seatsError')}</p>
        ) : (
          <table className={css({ width: '100%', borderCollapse: 'collapse' })}>
            <thead>
              <tr className={muted}>
                <th align="left">{t('admin.seat.subject')}</th>
                <th align="left">{t('admin.seat.role')}</th>
                <th align="left">{t('admin.seat.status')}</th>
                <th align="left">{t('admin.seat.workSeat')}</th>
              </tr>
            </thead>
            <tbody>
              {seats.map((seat) => (
                <tr key={seat.subject_id}>
                  <td>{seat.subject_id}</td>
                  <td>{seat.role}</td>
                  <td>{seat.status}</td>
                  <td>{seat.work_seat ? t('admin.yes') : t('admin.no')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {seatsQ.hasNextPage ? (
          <Button
            variant="secondary"
            size="dense"
            loading={seatsQ.isFetchingNextPage}
            onPress={() => seatsQ.fetchNextPage()}
          >
            {t('admin.loadMore')}
          </Button>
        ) : null}
      </section>

      <section className={card}>
        <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
          {t('admin.exportTitle')}
        </h2>
        <p className={muted}>{t('admin.exportDescription')}</p>
        <div
          className={css({
            display: 'flex',
            gap: 'sm',
            flexWrap: 'wrap',
            alignItems: 'end',
          })}
        >
          <label>
            <span className={muted}>{t('admin.from')}</span>
            <input
              type="date"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
            />
          </label>
          <label>
            <span className={muted}>{t('admin.to')}</span>
            <input
              type="date"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
            />
          </label>
          <label>
            <span className={muted}>{t('admin.format')}</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as 'csv' | 'json')}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <Button
            variant="primary"
            size="dense"
            loading={createExport.isPending}
            onPress={async () => {
              const created = await createExport.mutateAsync({
                client_request_id: crypto.randomUUID(),
                range_from: asRange(rangeFrom, false),
                range_to: asRange(rangeTo, true),
                format,
              })
              setExportId(created.id)
            }}
          >
            {t('admin.createExport')}
          </Button>
        </div>
        {createExport.isError ? (
          <p className={muted}>{t('admin.exportError')}</p>
        ) : null}
        {exportQ.data ? (
          <p className={muted}>
            {t('admin.exportStatus')}: {exportQ.data.status}
            {' · '}
            {t('admin.exportRows')}: {exportQ.data.row_count ?? '—'}
            {exportQ.data.download_available ? (
              <Button
                variant="secondary"
                size="dense"
                loading={downloadExport.isPending}
                onPress={() =>
                  void downloadExport.mutateAsync(exportQ.data!.id)
                }
              >
                {t('admin.download')}
              </Button>
            ) : null}
          </p>
        ) : null}
      </section>
    </div>
  )
}
