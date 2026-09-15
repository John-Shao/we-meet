import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Redirect, useLocation } from 'wouter'
import {
  RiMicLine,
  RiUpload2Line,
  RiVidiconLine,
  RiFileTextLine,
  RiSearchLine,
  RiFilter3Line,
  RiLayoutGridLine,
  RiListUnordered,
} from '@remixicon/react'
import { openGlobalSearch } from '@/layout/globalSearchBus'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useMeetingRecords } from '../api/fetchMeetingRecord'
import { libraryLayout } from '../components/libraryStyles'
import { MeetingModuleNav } from '../components/MeetingModuleNav'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { RecordingUpload } from '../components/RecordingUpload'
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
const iconButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '2.75rem',
  height: '2.75rem',
  borderRadius: '0.75rem',
  cursor: 'pointer',
  color: 'greyscale.600',
  flexShrink: 0,
  _hover: { backgroundColor: 'greyscale.100' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '2px',
  },
  '&[aria-pressed=true]': {
    color: 'primary.700',
    backgroundColor: 'primary.100',
  },
  '&[data-desktop-only]': { display: { base: 'none', md: 'inline-flex' } },
})

/** Paged sections keep bounded private content and never merge another filter's cache. */
function RecordList({
  viewerId,
  filters,
  ongoing,
  grid,
  minutes = false,
}: {
  viewerId: string
  filters: MeetingRecordFilters
  ongoing: boolean
  grid: boolean
  minutes?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [cursors, setCursors] = useState<string[]>([''])
  const query = useMeetingRecords(viewerId, true, {
    ...filters,
    is_ongoing: minutes ? undefined : ongoing ? 'true' : 'false',
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
  if (ongoing && !query.data.results.length) return null
  return (
    <section
      aria-label={t(
        minutes
          ? 'minutesLibrary.all'
          : ongoing
            ? 'library.ongoing'
            : 'library.archive'
      )}
    >
      <h2
        className={css({
          fontSize: '0.875rem',
          color: 'greyscale.600',
          fontWeight: 600,
          margin: '1.25rem 0 0.75rem',
        })}
      >
        {t(
          minutes
            ? 'minutesLibrary.all'
            : ongoing
              ? 'library.ongoing'
              : 'library.archive'
        )}
      </h2>
      {!query.data.results.length && (
        <div
          className={css({
            textAlign: 'center',
            padding: '4rem 1rem',
            borderRadius: '1rem',
            backgroundColor: 'surface.default',
          })}
        >
          <RiFileTextLine
            size={36}
            aria-hidden
            className={css({ margin: '0 auto 1rem', color: 'greyscale.400' })}
          />
          <p className={css({ fontWeight: 600 })}>
            {t(minutes ? 'minutesLibrary.empty' : 'library.empty')}
          </p>
          <p
            className={css({
              marginTop: '0.5rem',
              color: 'greyscale.600',
              fontSize: '0.875rem',
            })}
          >
            {t(minutes ? 'minutesLibrary.emptyHint' : 'library.emptyHint')}
          </p>
        </div>
      )}
      <ul
        className={css({
          display: 'grid',
          gap: '0.75rem',
          gridTemplateColumns: '1fr',
          '&[data-grid=true]': {
            md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          },
        })}
        data-grid={grid}
      >
        {query.data.results.map((record) => (
          <li key={record.id}>
            <Link
              href={`/meeting/records/${record.id}${minutes ? '?tab=summary' : ''}`}
              data-minutes={minutes}
              aria-label={record.title || t('library.untitled')}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                height: '100%',
                padding: { base: '1rem', md: '1.5rem' },
                borderRadius: '1rem',
                backgroundColor: 'surface.default',
                border: '1px solid token(colors.greyscale.100)',
                textDecoration: 'none',
                color: 'greyscale.900',
                _hover: {
                  borderColor: 'primary.300',
                  boxShadow: '0 3px 12px rgba(0, 0, 0, 0.04)',
                },
                _focusVisible: {
                  outline: '2px solid token(colors.primary.500)',
                  outlineOffset: '2px',
                },
                '&[data-minutes=true]': {
                  borderColor: 'transparent',
                  padding: '1.25rem 0.75rem',
                  _hover: { backgroundColor: 'surface.canvas' },
                },
              })}
            >
              <span
                aria-hidden
                className={css({
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  width: '3rem',
                  height: '3rem',
                  borderRadius: '0.875rem',
                  backgroundColor: 'primary.100',
                  color: 'primary.600',
                })}
              >
                {minutes ? (
                  <RiFileTextLine size={25} />
                ) : record.source_type === 'meeting' ? (
                  <RiVidiconLine size={25} />
                ) : record.source_type === 'upload' ? (
                  <RiUpload2Line size={25} />
                ) : (
                  <RiMicLine size={25} />
                )}
              </span>
              <div className={css({ minWidth: 0, flex: 1 })}>
                <h3
                  className={css({
                    fontSize: '1rem',
                    fontWeight: 600,
                    lineHeight: 1.5,
                    lineClamp: 2,
                  })}
                >
                  {record.title || t('library.untitled')}
                </h3>
                <p
                  className={css({
                    color: 'greyscale.600',
                    fontSize: '0.8125rem',
                    marginTop: '0.5rem',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                  })}
                >
                  <time dateTime={record.origin_at}>
                    {minutes && `${t('minutesLibrary.recordedAt')} `}
                    {new Date(record.origin_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      ...(new Date(record.origin_at).getFullYear() !==
                      new Date().getFullYear()
                        ? { year: 'numeric' }
                        : {}),
                    })}
                  </time>
                  <span aria-hidden>·</span>
                  <span>{t(`library.source.${record.source_type}`)}</span>
                </p>
                {!minutes && (ongoing || record.has_summary) && (
                  <p
                    className={css({
                      display: 'flex',
                      gap: '0.5rem',
                      marginTop: '0.5rem',
                      fontSize: '0.75rem',
                      color: 'primary.700',
                    })}
                  >
                    {ongoing && <span>{t('library.ongoing')}</span>}
                    {record.has_summary && (
                      <span>{t('library.minutesReady')}</span>
                    )}
                  </p>
                )}
              </div>
            </Link>
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
}: {
  viewerId: string
  minutes?: boolean
}) {
  const { t } = useTranslation('meetings')
  const { data: config } = useConfig()
  const [, navigate] = useLocation()
  const [scope, setScope] = useState<MeetingRecordFilters['scope']>(
    minutes ? 'owned' : 'recent'
  )
  const [source, setSource] = useState<MeetingRecordSource | ''>('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [grid, setGrid] = useState(false)
  const filters: MeetingRecordFilters = {
    scope,
    source_type: source || undefined,
    q: query,
    ...(minutes ? { has_summary: 'true' } : {}),
  }
  const filterKey = JSON.stringify([viewerId, filters])
  return (
    <MeetingModuleShell compactNavigation>
      <main
        data-minutes={minutes}
        className={css({
          width: '100%',
          maxWidth: '1120px',
          margin: '0 auto',
          padding: { base: '1rem', md: '2rem 2.5rem' },
          minHeight: '100%',
          backgroundColor: 'surface.canvas',
          '&[data-minutes=true]': { backgroundColor: 'surface.default' },
        })}
      >
        <div className={css({ md: { display: 'none' } })}>
          <MeetingModuleNav
            current={minutes ? '/meeting/minutes' : '/meeting/notes'}
          />
        </div>
        <header
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            marginBottom: '1.75rem',
          })}
        >
          <div>
            <h1
              className={css({
                fontSize: '1.5rem',
                fontWeight: 700,
                marginBottom: '0.75rem',
              })}
            >
              {t(minutes ? 'library.minutes' : 'library.notes')}
            </h1>
            <p
              className={css({ color: 'greyscale.600', fontSize: '0.875rem' })}
            >
              {t(minutes ? 'library.minutesHint' : 'library.notesHint')}
            </p>
          </div>
          {config?.search_ai?.enabled !== false && (
            <Button
              variant="tertiary"
              onPress={() => openGlobalSearch('ai', 'meetings')}
            >
              {t('minutesReader.searchMeetings')}
            </Button>
          )}
          {!minutes && (
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
              })}
            >
              <RecordingUpload viewerId={viewerId} />
              {config?.meeting_records?.capture_audio_enabled && (
                <Button
                  icon={<RiMicLine size={18} aria-hidden />}
                  onPress={() => navigate('/meeting/recording')}
                >
                  {t('library.startRecording')}
                </Button>
              )}
            </div>
          )}
        </header>
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1rem',
          })}
        >
          <div
            role="group"
            aria-label={t('library.scopeLabel')}
            className={css({
              display: 'flex',
              flex: 1,
              gap: '0.5rem',
              overflowX: 'auto',
            })}
          >
            {(minutes
              ? (['owned', 'participated', 'shared'] as const)
              : (['recent', 'owned', 'shared'] as const)
            ).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                data-minutes={minutes}
                onClick={() => setScope(value)}
                className={css({
                  padding: {
                    base: '0.625rem 0.875rem',
                    md: '0.625rem 1.25rem',
                  },
                  borderRadius: '2rem',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  color: 'greyscale.600',
                  backgroundColor: 'greyscale.100',
                  '&[aria-pressed=true]': {
                    color: 'primary.700',
                    backgroundColor: 'primary.100',
                    fontWeight: 600,
                  },
                  _focusVisible: {
                    outline: '2px solid token(colors.primary.500)',
                    outlineOffset: '2px',
                  },
                  '&[data-minutes=true]': {
                    backgroundColor: 'transparent',
                    borderRadius: 0,
                    borderBottom: '3px solid transparent',
                    '&[aria-pressed=true]': {
                      backgroundColor: 'transparent',
                      borderBottomColor: 'primary.600',
                    },
                  },
                })}
              >
                {t(
                  `${minutes ? 'minutesLibrary.scope' : 'library.scope'}.${value}`
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={iconButton}
            aria-label={t('library.filters')}
            aria-expanded={showFilters}
            aria-pressed={Boolean(
              source || (!minutes && scope === 'participated')
            )}
            onClick={() => setShowFilters(!showFilters)}
          >
            <RiFilter3Line size={20} aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            data-desktop-only
            aria-label={t(grid ? 'library.listView' : 'library.gridView')}
            aria-pressed={grid}
            onClick={() => setGrid(!grid)}
          >
            {grid ? (
              <RiListUnordered size={20} aria-hidden />
            ) : (
              <RiLayoutGridLine size={20} aria-hidden />
            )}
          </button>
        </div>
        <form
          className={row}
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(search.trim())
          }}
        >
          <label
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              backgroundColor: 'surface.default',
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '0.75rem',
              padding: '0 0.75rem',
              flex: '1 1 14rem',
            })}
          >
            <RiSearchLine
              size={18}
              aria-hidden
              className={css({ color: 'greyscale.500' })}
            />
            <input
              className={css({
                minWidth: 0,
                width: '100%',
                padding: '0.75rem 0',
                backgroundColor: 'transparent',
                outlineOffset: '2px',
              })}
              aria-label={t('library.search')}
              placeholder={t('library.search')}
              type="search"
              maxLength={200}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                if (!event.target.value) setQuery('')
              }}
            />
          </label>
          <Button type="submit" variant="secondary">
            {t('library.searchButton')}
          </Button>
          {showFilters && (
            <div
              className={css({
                display: 'flex',
                flexWrap: 'wrap',
                gap: '1rem',
                flexBasis: '100%',
                padding: '1rem',
                borderRadius: '0.75rem',
                backgroundColor: 'surface.default',
              })}
            >
              <label>
                {t('library.scopeLabel')}{' '}
                <select
                  className={field}
                  value={scope}
                  onChange={(event) =>
                    setScope(
                      event.target.value as MeetingRecordFilters['scope']
                    )
                  }
                >
                  {(['recent', 'owned', 'participated', 'shared'] as const)
                    .filter((value) => !minutes || value !== 'recent')
                    .map((value) => (
                      <option key={value} value={value}>
                        {t(
                          `${minutes ? 'minutesLibrary.scope' : 'library.scope'}.${value}`
                        )}
                      </option>
                    ))}
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
            </div>
          )}
        </form>
        {!minutes && (
          <RecordList
            key={`${filterKey}:ongoing`}
            viewerId={viewerId}
            filters={filters}
            ongoing
            grid={grid}
          />
        )}
        <RecordList
          key={`${filterKey}:archive`}
          viewerId={viewerId}
          filters={filters}
          ongoing={false}
          grid={grid}
          minutes={minutes}
        />
      </main>
    </MeetingModuleShell>
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
      <MeetingModuleShell>
        <main className={libraryLayout}>
          <Link href="/meeting">{t('library.home')}</Link>
          <p>{t('library.unavailable')}</p>
        </main>
      </MeetingModuleShell>
    )
  return (
    <Library
      key={`${user.id}:${minutes}`}
      viewerId={user.id}
      minutes={minutes}
    />
  )
}
export function MeetingNotes() {
  return <LibraryRoute />
}
export function MeetingMinutes() {
  return <LibraryRoute minutes />
}
