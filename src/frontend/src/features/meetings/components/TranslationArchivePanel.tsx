import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'

interface Archive {
  id: string
  target: 'zh' | 'en'
  generation: number
  status: 'capturing' | 'complete' | 'incomplete'
  segment_count: number
  created_at: string
}
interface Segment {
  id: string
  sequence: number
  target: 'zh' | 'en'
  text: string
  speaker_label: string
  received_at: string
  timing_basis: 'delivery'
  original_id: null
}
interface Page<T> {
  results: T[]
  next_cursor: string | null
}
const privateOptions = { retry: false, gcTime: 0, staleTime: 0 }
const layout = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  minWidth: 0,
})

function PageButtons({
  cursors,
  next,
  change,
}: {
  cursors: string[]
  next?: string | null
  change: (value: string[]) => void
}) {
  const { t } = useTranslation('meetings', { keyPrefix: 'library' })
  return (
    <div className={css({ display: 'flex', gap: '0.75rem' })}>
      {cursors.length > 1 && (
        <Button variant="tertiary" onPress={() => change(cursors.slice(0, -1))}>
          {t('previous')}
        </Button>
      )}
      {next && (
        <Button variant="tertiary" onPress={() => change([...cursors, next])}>
          {t('next')}
        </Button>
      )}
    </div>
  )
}

function ArchiveSegments({
  viewerId,
  recordId,
  archiveId,
  back,
}: {
  viewerId: string
  recordId: string
  archiveId: string
  back: () => void
}) {
  const { t } = useTranslation('meetings', { keyPrefix: 'translationArchive' })
  const [cursors, setCursors] = useState([''])
  const path = `meeting-records/${recordId}/translation-segments/?${new URLSearchParams({ archive_id: archiveId, cursor: cursors.at(-1)! })}`
  const query = useQuery({
    ...privateOptions,
    queryKey: ['translation-segments', viewerId, path],
    queryFn: ({ signal }) =>
      fetchApi<
        Page<Segment> & {
          archive_id: string
          archive_status: Archive['status']
          target: Archive['target']
        }
      >(path, { signal, cache: 'no-store' }),
    refetchInterval: (query) => (query.state.error ? false : 10000),
  })
  return (
    <section className={layout}>
      <Button variant="tertiary" onPress={back}>
        {t('back')}
      </Button>
      {query.isError || (query.data && query.data.archive_id !== archiveId) ? (
        <div role="alert">
          <Text>{t('error')}</Text>
          <Button variant="tertiary" onPress={() => void query.refetch()}>
            {t('refresh')}
          </Button>
        </div>
      ) : !query.data ? (
        <Text role="status">{t('loading')}</Text>
      ) : (
        <>
          <Text>
            {t(`language.${query.data.target}`)} ·{' '}
            {t(`status.${query.data.archive_status}`)}
          </Text>
          <Text variant="note">{t('timingHint')}</Text>
          {query.data.archive_status === 'incomplete' && (
            <Text role="status">{t('incompleteHint')}</Text>
          )}
          {!query.data.results.length && <Text>{t('empty')}</Text>}
          {query.data.results.map((row) => (
            <article
              key={row.id}
              className={css({
                borderBottomWidth: '1px',
                borderColor: 'border.default',
                paddingY: '0.75rem',
              })}
            >
              <Text variant="note">
                {row.speaker_label || t('unknownSpeaker')} ·{' '}
                {t('received', {
                  time: new Date(row.received_at).toLocaleTimeString(),
                })}
              </Text>
              <Text
                className={css({
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                })}
              >
                {row.text}
              </Text>
            </article>
          ))}
          <PageButtons
            cursors={cursors}
            next={query.data.next_cursor}
            change={setCursors}
          />
        </>
      )}
    </section>
  )
}

export function TranslationArchivePanel({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  const { t } = useTranslation('meetings', { keyPrefix: 'translationArchive' })
  const [cursors, setCursors] = useState([''])
  const [selected, setSelected] = useState<string>()
  const path = `meeting-records/${recordId}/translation-archives/?cursor=${encodeURIComponent(cursors.at(-1)!)}`
  const query = useQuery({
    ...privateOptions,
    queryKey: ['translation-archives', viewerId, path],
    queryFn: ({ signal }) =>
      fetchApi<Page<Archive>>(path, { signal, cache: 'no-store' }),
    refetchInterval: (query) => (query.state.error ? false : 10000),
  })
  if (query.isError)
    return (
      <div role="alert">
        <Text>{t('error')}</Text>
        <Button variant="tertiary" onPress={() => void query.refetch()}>
          {t('refresh')}
        </Button>
      </div>
    )
  if (!query.data) return <Text role="status">{t('loading')}</Text>
  if (selected)
    return (
      <ArchiveSegments
        key={`${viewerId}:${recordId}:${selected}`}
        viewerId={viewerId}
        recordId={recordId}
        archiveId={selected}
        back={() => setSelected(undefined)}
      />
    )
  return (
    <section aria-label={t('title')} className={layout}>
      <Text variant="note">{t('scope')}</Text>
      {!query.data.results.length && <Text>{t('empty')}</Text>}
      {query.data.results.map((archive) => (
        <article key={archive.id} className={layout}>
          <Text>
            {t('version', {
              language: t(`language.${archive.target}`),
              generation: archive.generation,
            })}{' '}
            · {t(`status.${archive.status}`)}
          </Text>
          <Text variant="note">
            {new Date(archive.created_at).toLocaleString()} ·{' '}
            {t('count', { count: archive.segment_count })}
          </Text>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => setSelected(archive.id)}
          >
            {t('open', {
              language: t(`language.${archive.target}`),
              generation: archive.generation,
            })}
          </Button>
        </article>
      ))}
      <PageButtons
        cursors={cursors}
        next={query.data.next_cursor}
        change={setCursors}
      />
    </section>
  )
}
