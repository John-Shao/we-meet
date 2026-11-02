import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives/Button'
import { PageState } from '@/components/PageState'
import { css } from '@/styled-system/css'
import { AdminProviderPanel } from '../components/AdminProviderPanel'
import {
  useAdminAuditExport,
  useAdminOverview,
  useAdminProviderConfig,
  useAdminSeats,
  useAdminUsage,
  useCreateAdminAuditExport,
  useDownloadAdminAuditExport,
  useWorkBootstrap,
} from '../api/queries'
import { useReadOnlyViewport } from '../hooks/useReadOnlyViewport'
import { card, muted, notice, page } from '../ui'

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
  const readOnly = useReadOnlyViewport()
  const bootstrapQ = useWorkBootstrap()
  const overviewQ = useAdminOverview()
  const seatsQ = useAdminSeats()
  const providerQ = useAdminProviderConfig()
  const createExport = useCreateAdminAuditExport()
  const downloadExport = useDownloadAdminAuditExport()
  const [rangeFrom, setRangeFrom] = useState(dateInput(7))
  const [rangeTo, setRangeTo] = useState(dateInput(1))
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [exportId, setExportId] = useState<string>()
  const exportQ = useAdminAuditExport(exportId)
  const usageQ = useAdminUsage(rangeFrom, rangeTo)

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
              <dt className={muted}>{t('admin.period')}</dt>
              <dd className={css({ margin: 0 })}>{overview.quota_period_id}</dd>
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
                <th scope="col" className={headCell}>
                  {t('admin.seat.subject')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.seat.role')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.seat.status')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.seat.workSeat')}
                </th>
              </tr>
            </thead>
            <tbody>
              {seats.map((seat) => (
                <tr key={seat.subject_id} className={rowLine}>
                  <td className={subjectCell}>{seat.subject_id}</td>
                  <td className={bodyCell}>{seat.role}</td>
                  <td className={bodyCell}>{seat.status}</td>
                  <td className={bodyCell}>
                    {seat.work_seat ? t('admin.yes') : t('admin.no')}
                  </td>
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
        {readOnly ? (
          <p className={notice}>{t('admin.exportMobileNotice')}</p>
        ) : (
          <>
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
          </>
        )}
      </section>

      {role === 'owner' ? (
        <AdminProviderPanel />
      ) : (
        <section className={card}>
          <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
            {t('admin.providerTitle')}
          </h2>
          {providerQ.isPending ? (
            <p className={muted}>{t('loading')}</p>
          ) : providerQ.isError ? (
            <p className={muted}>
              {isNotConfigured(providerQ.error)
                ? t('admin.providerEmpty')
                : t('admin.providerError')}
            </p>
          ) : (
            <dl
              className={css({
                display: 'grid',
                gridTemplateColumns: { base: '1fr', md: 'repeat(3, 1fr)' },
                gap: 'md',
                margin: 0,
              })}
            >
              {(
                [
                  [t('admin.providerField'), providerQ.data.provider],
                  [t('admin.modelField'), providerQ.data.model],
                  [t('admin.regionField'), providerQ.data.region || '—'],
                  [t('admin.endpointField'), providerQ.data.endpoint || '—'],
                  [t('admin.credentialMode'), providerQ.data.credential_mode],
                  [
                    t('admin.fingerprint'),
                    providerQ.data.credential.fingerprint,
                  ],
                  [t('admin.state'), providerQ.data.state],
                  [t('admin.revision'), String(providerQ.data.revision)],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className={muted}>{label}</dt>
                  <dd className={css({ margin: 0, wordBreak: 'break-all' })}>
                    {value || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}

      <section className={card}>
        <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
          {t('admin.usageTitle')}
        </h2>
        <p className={muted}>
          {rangeFrom} – {rangeTo}
        </p>
        <p className={notice}>{t('admin.usageNote')}</p>
        {usageQ.isPending ? (
          <p className={muted}>{t('loading')}</p>
        ) : usageQ.isError ? (
          <p className={muted}>{t('admin.usageError')}</p>
        ) : usageQ.data.items.length === 0 ? (
          <p className={muted}>{t('admin.usageEmpty')}</p>
        ) : readOnly ? (
          // 六列表格在 369px 真机宽度下会撑出横向滚动，窄屏改为逐行堆叠的只读列表。
          <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
            {usageQ.data.items.map((row) => (
              <li key={`${row.provider}:${row.model}`} className={rowLine}>
                <p className={css({ margin: 0 })}>{row.model}</p>
                <dl
                  className={css({
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: 'xs',
                    margin: 0,
                  })}
                >
                  {[
                    [t('admin.usage.provider'), row.provider],
                    [t('admin.usage.input'), row.input_tokens.toLocaleString()],
                    [
                      t('admin.usage.output'),
                      row.output_tokens.toLocaleString(),
                    ],
                    [
                      t('admin.usage.cached'),
                      row.cached_input_tokens.toLocaleString(),
                    ],
                    [t('admin.usage.runs'), row.run_count.toLocaleString()],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className={muted}>{label}</dt>
                      <dd className={css({ margin: 0 })}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <table className={css({ width: '100%', borderCollapse: 'collapse' })}>
            <thead>
              <tr className={muted}>
                <th scope="col" className={headCell}>
                  {t('admin.usage.provider')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.usage.model')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.usage.input')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.usage.output')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.usage.cached')}
                </th>
                <th scope="col" className={headCell}>
                  {t('admin.usage.runs')}
                </th>
              </tr>
            </thead>
            <tbody>
              {usageQ.data.items.map((row) => (
                <tr key={`${row.provider}:${row.model}`} className={rowLine}>
                  <td className={bodyCell}>{row.provider}</td>
                  <td className={subjectCell}>{row.model}</td>
                  <td className={bodyCell}>
                    {row.input_tokens.toLocaleString()}
                  </td>
                  <td className={bodyCell}>
                    {row.output_tokens.toLocaleString()}
                  </td>
                  <td className={bodyCell}>
                    {row.cached_input_tokens.toLocaleString()}
                  </td>
                  <td className={bodyCell}>{row.run_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

const isNotConfigured = (error: unknown) =>
  (error as { code?: string } | null)?.code === 'not_found'

// 席位表在 369px 真机视口下曾把四列挤成 `memberactive否`：单元格无内边距。
const cellBase = {
  paddingY: 'xs',
  paddingInlineEnd: 'md',
  textAlign: 'left' as const,
  verticalAlign: 'top' as const,
}

const headCell = css({ ...cellBase, whiteSpace: 'nowrap' })
const bodyCell = css(cellBase)
const subjectCell = css({ ...cellBase, wordBreak: 'break-all' })
const rowLine = css({
  borderTop: '1px solid token(colors.border.subtle)',
})
