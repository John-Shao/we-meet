import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Redirect } from 'wouter'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useMeetingRecords } from '../api/fetchMeetingRecord'
import { libraryLayout } from '../components/libraryStyles'
import type {
  MeetingRecordFilters,
  MeetingRecordSource,
} from '../api/ApiMeetingRecord'

const row = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  alignItems: 'center',
  marginBottom: '1rem',
})
const field = css({
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '0.375rem',
  padding: '0.5rem',
  backgroundColor: 'transparent',
  maxWidth: '100%',
})

/** Paged sections keep bounded private content and never merge another filter's cache. */
function RecordList({
  viewerId,
  filters,
  ongoing,
}: {
  viewerId: string
  filters: MeetingRecordFilters
  ongoing: boolean
}) {
  const { t } = useTranslation('meetings')
  const [cursors, setCursors] = useState<string[]>([''])
  const query = useMeetingRecords(viewerId, true, {
    ...filters,
    is_ongoing: ongoing ? 'true' : 'false',
    cursor: cursors.at(-1),
  })
  if (query.isError)
    return (
      <div role="alert">
        {t('library.loadError')}{' '}
        <Button variant="tertiary" onPress={() => void query.refetch()}>
          {t('library.refresh')}
        </Button>
      </div>
    )
  if (!query.data) return <p role="status">{t('loading')}</p>
  return (
    <section aria-label={t(ongoing ? 'library.ongoing' : 'library.archive')}>
      <h2 className={css({ fontWeight: 600, margin: '1rem 0' })}>
        {t(ongoing ? 'library.ongoing' : 'library.archive')}
      </h2>
      {!query.data.results.length && (
        <p>{t(ongoing ? 'library.noOngoing' : 'library.empty')}</p>
      )}
      <ul>
        {query.data.results.map((record) => (
          <li
            key={record.id}
            className={css({
              borderBottom: '1px solid token(colors.greyscale.200)',
              padding: '1rem 0',
            })}
          >
            <Link
              href={`/meeting/records/${record.id}`}
              className={css({
                color: 'primary.700',
                fontWeight: 600,
                display: 'inline-block',
                padding: '0.25rem 0',
              })}
            >
              {record.title || t('library.untitled')}
            </Link>
            <p className={css({ fontSize: '0.875rem', marginTop: '0.375rem' })}>
              {t(`library.source.${record.source_type}`)} ·{' '}
              {new Date(record.origin_at).toLocaleString()}{' '}
              {record.has_summary && ` · ${t('library.minutesReady')}`}
            </p>
          </li>
        ))}
      </ul>
      <div className={row}>
        {cursors.length > 1 && (
          <Button
            variant="tertiary"
            onPress={() => setCursors((values) => values.slice(0, -1))}
          >
            {t('library.previous')}
          </Button>
        )}
        {query.data.next_cursor && (
          <Button
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

export function Library({
  viewerId,
  minutes = false,
  captureEnabled = false,
}: {
  viewerId: string
  minutes?: boolean
  captureEnabled?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [scope, setScope] = useState<MeetingRecordFilters['scope']>('recent')
  const [source, setSource] = useState<MeetingRecordSource | ''>('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const filters: MeetingRecordFilters = {
    scope,
    source_type: source || undefined,
    q: query,
    ...(minutes ? { has_summary: 'true' } : {}),
  }
  const filterKey = JSON.stringify([viewerId, filters])
  return (
    <Screen>
      <main className={libraryLayout}>
        <nav className={row} aria-label={t('library.navigation')}>
          <Link href="/meeting">{t('library.home')}</Link>
          <Link
            href="/meeting/notes"
            aria-current={!minutes ? 'page' : undefined}
          >
            {t('library.notes')}
          </Link>
          <Link
            href="/meeting/minutes"
            aria-current={minutes ? 'page' : undefined}
          >
            {t('library.minutes')}
          </Link>
          {captureEnabled && (
            <Link href="/meeting/recording">{t('library.record')}</Link>
          )}
        </nav>
        <h1
          className={css({
            fontSize: '1.5rem',
            fontWeight: 700,
            marginBottom: '0.75rem',
          })}
        >
          {t(minutes ? 'library.minutes' : 'library.notes')}
        </h1>
        <p className={css({ marginBottom: '1rem' })}>
          {t(minutes ? 'library.minutesHint' : 'library.notesHint')}
        </p>
        <form
          className={row}
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(search.trim())
          }}
        >
          <label>
            {t('library.search')}{' '}
            <input
              className={field}
              type="search"
              maxLength={200}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button type="submit" variant="secondary">
            {t('library.searchButton')}
          </Button>
          <label>
            {t('library.scopeLabel')}{' '}
            <select
              className={field}
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as MeetingRecordFilters['scope'])
              }
            >
              {(['recent', 'owned', 'participated', 'shared'] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`library.scope.${value}`)}
                  </option>
                )
              )}
            </select>
          </label>
          <label>
            {t('library.sourceLabel')}{' '}
            <select
              className={field}
              value={source}
              onChange={(event) =>
                setSource(event.target.value as MeetingRecordSource | '')
              }
            >
              <option value="">{t('library.allSources')}</option>
              {(['meeting', 'audio_recording', 'upload'] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`library.source.${value}`)}
                  </option>
                )
              )}
            </select>
          </label>
        </form>
        <RecordList
          key={`${filterKey}:ongoing`}
          viewerId={viewerId}
          filters={filters}
          ongoing
        />
        <RecordList
          key={`${filterKey}:archive`}
          viewerId={viewerId}
          filters={filters}
          ongoing={false}
        />
      </main>
    </Screen>
  )
}

function LibraryRoute({ minutes = false }: { minutes?: boolean }) {
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError)) return <p role="status">{t('loading')}</p>
  if (isError || !data?.meeting_records?.enabled)
    return (
      <Screen>
        <main className={libraryLayout}>
          <Link href="/meeting">{t('library.home')}</Link>
          <p>{t('library.unavailable')}</p>
        </main>
      </Screen>
    )
  return (
    <Library
      key={`${user.id}:${minutes}`}
      viewerId={user.id}
      minutes={minutes}
      captureEnabled={!!data.meeting_records.capture_audio_enabled}
    />
  )
}
export function MeetingNotes() {
  return <LibraryRoute />
}
export function MeetingMinutes() {
  return <LibraryRoute minutes />
}
