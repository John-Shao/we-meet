import { RecordPanelTools } from './RecordPanel'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { css } from '@/styled-system/css'
import { formatClock, formatDateTime } from '../recordDateTime'

interface Archive {
  id: string
  source_kind?: 'channel' | 'private'
  mode?: 'simultaneous' | 'push_to_talk'
  source?: 'zh' | 'en' | null
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
  gap: 'md',
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
    <div className={css({ display: 'flex', gap: 'md' })}>
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
          source_kind?: Archive['source_kind']
          mode?: Archive['mode']
          source?: Archive['source']
        }
      >(path, { signal, cache: 'no-store' }),
    refetchInterval: (query) => (query.state.error ? false : 10000),
  })
  return (
    <section className={layout}>
      <RecordPanelTools>
        <Button variant="tertiary" onPress={back}>
          {t('back')}
        </Button>
      </RecordPanelTools>
      {query.isError || (query.data && query.data.archive_id !== archiveId) ? (
        <StateHint
          state="error"
          action={
            <Button variant="tertiary" onPress={() => void query.refetch()}>
              {t('refresh')}
            </Button>
          }
        >
          {t('error')}
        </StateHint>
      ) : !query.data ? (
        <StateHint state="loading">{t('loading')}</StateHint>
      ) : (
        <>
          <Text>
            {query.data.mode === 'push_to_talk' &&
              query.data.source &&
              `${t(`language.${query.data.source}`)} ↔ `}
            {t(`language.${query.data.target}`)} ·{' '}
            {t(`status.${query.data.archive_status}`)}
          </Text>
          <Text variant="note">{t('timingHint')}</Text>
          {query.data.source_kind === 'private' && (
            <Text variant="note">{t('privateScope')}</Text>
          )}
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
                paddingY: 'md',
              })}
            >
              <Text variant="note">
                {row.speaker_label || t('unknownSpeaker')} ·{' '}
                {t(`language.${row.target}`)} ·{' '}
                {t('received', {
                  time: formatClock(row.received_at),
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
      <StateHint
        state="error"
        action={
          <Button variant="tertiary" onPress={() => void query.refetch()}>
            {t('refresh')}
          </Button>
        }
      >
        {t('error')}
      </StateHint>
    )
  if (!query.data) return <StateHint state="loading">{t('loading')}</StateHint>
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
            {archive.source_kind === 'private' && `${t('privateScope')} · `}
            {archive.mode === 'push_to_talk' && `${t('bidirectional')} · `}
            {formatDateTime(archive.created_at)} ·{' '}
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
