import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

type ExportReceipt = {
  id: string
  source_kind: 'ai' | 'human'
  source_id: string
  status: string
  language: string
  created_at: string
  document_id: string | null
  can_open: boolean
}

/** Existing receipts only. Opening record information must never create a copy. */
export function RecordDocuments({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  return (
    <DocumentHistory
      key={`${viewerId}:${recordId}`}
      viewerId={viewerId}
      recordId={recordId}
    />
  )
}

function DocumentHistory({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  const { t } = useTranslation('meetings')
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const cursor = cursors[cursors.length - 1]
  const path = `meeting-records/${encodeURIComponent(recordId)}/document-exports/${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
  const query = useQuery({
    queryKey: ['summary-exports', viewerId, recordId, path],
    queryFn: ({ signal }) =>
      fetchApi<{
        available?: boolean
        results: ExportReceipt[]
        next_cursor?: string | null
      }>(path, { signal }),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (state) =>
      state.state.status === 'error' ? false : 15000,
  })
  return (
    <section
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'md',
      })}
    >
      <h3>{t('recordDocuments.title')}</h3>
      <p>{t('recordDocuments.hint')}</p>
      {query.isError ? (
        <>
          <p>{t('library.loadError')}</p>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => void query.refetch()}
          >
            {t('library.refresh')}
          </Button>
        </>
      ) : !query.data ? (
        <p>{t('loading')}</p>
      ) : query.data.results.length === 0 ? (
        <>
          <p>{t('recordDocuments.empty')}</p>
          {query.data.available === true && (
            <p>{t('recordDocuments.createHint')}</p>
          )}
        </>
      ) : (
        query.data.results.map((row) => (
          <article
            key={row.id}
            className={css({
              display: 'flex',
              flexDirection: 'column',
              gap: 'sm',
            })}
          >
            <p>
              {t(
                row.source_kind === 'human'
                  ? 'recordDocuments.human'
                  : 'recordDocuments.ai'
              )}{' '}
              · {new Date(row.created_at).toLocaleString()} · {row.language}
            </p>
            <p>{t(`summaryExport.status.${row.status}`)}</p>
            {row.status === 'ready' && row.can_open && row.document_id && (
              <Link href={`/docs/${encodeURIComponent(row.document_id)}`}>
                {t('summaryExport.openDocument')}
              </Link>
            )}
            {['ai', 'human'].includes(row.source_kind) && (
              <Link
                href={`/meeting/records/${encodeURIComponent(recordId)}?${row.source_kind === 'human' ? 'human' : 'summary'}=${encodeURIComponent(row.source_id)}`}
              >
                {t('recordDocuments.source')}
              </Link>
            )}
          </article>
        ))
      )}
      <div className={css({ display: 'flex', gap: 'sm' })}>
        {cursors.length > 1 && (
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => setCursors((values) => values.slice(0, -1))}
          >
            {t('library.previous')}
          </Button>
        )}
        {!query.isError && query.data?.next_cursor && (
          <Button
            size="sm"
            variant="tertiary"
            onPress={() =>
              setCursors((values) => [...values, query.data!.next_cursor!])
            }
          >
            {t('library.next')}
          </Button>
        )}
      </div>
    </section>
  )
}
