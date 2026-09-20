import { useQuery } from '@tanstack/react-query'
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
  const { t } = useTranslation('meetings')
  const path = `meeting-records/${encodeURIComponent(recordId)}/document-exports/`
  const query = useQuery({
    queryKey: ['summary-exports', viewerId, recordId, path],
    queryFn: ({ signal }) =>
      fetchApi<{ results: ExportReceipt[] }>(path, { signal }),
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
        gap: '0.75rem',
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
        <p>{t('recordDocuments.empty')}</p>
      ) : (
        query.data.results.map((row) => (
          <article
            key={row.id}
            className={css({
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
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
            {row.source_kind === 'ai' && (
              <Link
                href={`/meeting/records/${encodeURIComponent(recordId)}?summary=${encodeURIComponent(row.source_id)}`}
              >
                {t('recordDocuments.source')}
              </Link>
            )}
          </article>
        ))
      )}
    </section>
  )
}
