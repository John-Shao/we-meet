import { useTranslation } from 'react-i18next'
import { Link, Redirect } from 'wouter'
import { RiMicLine } from '@remixicon/react'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useMeetingRecords } from '../api/fetchMeetingRecord'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { MeetingModuleNav } from '../components/MeetingModuleNav'
import { libraryLayout } from '../components/libraryStyles'

/** Only history is read here. Capture controls mount at /recording/capture. */
export function RecordingHistory({
  viewerId,
  enabled,
}: {
  viewerId: string
  enabled: boolean
}) {
  const { t, i18n } = useTranslation('meetings')
  const query = useMeetingRecords(viewerId, enabled, {
    scope: 'recent',
    source_type: 'audio_recording',
    is_ongoing: 'false',
  })
  if (!enabled) return null
  const rows = query.isError ? [] : query.data?.results.slice(0, 10)
  return (
    <section className={css({ marginTop: '2rem' })}>
      <h2 className={css({ fontSize: '1.25rem', marginBottom: '1rem' })}>
        {t('recordingOverview.history')}
      </h2>
      {query.isError ? (
        <div role="alert">
          <p>{t('library.loadError')}</p>
          <Button variant="tertiary" onPress={() => void query.refetch()}>
            {t('library.refresh')}
          </Button>
        </div>
      ) : !rows ? (
        <p role="status">{t('loading')}</p>
      ) : rows.length === 0 ? (
        <p>{t('recordingOverview.empty')}</p>
      ) : (
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: 0,
            border: '1px solid',
            borderColor: 'greyscale.200',
            borderRadius: '0.75rem',
            overflow: 'hidden',
          })}
        >
          {rows.map((record) => (
            <li
              key={record.id}
              className={css({
                '& + &': { borderTop: '1px solid token(colors.greyscale.200)' },
              })}
            >
              <Link
                href={`/meeting/recording/history/${encodeURIComponent(record.id)}`}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '1rem',
                  color: 'inherit',
                  _hover: { backgroundColor: 'surface.muted' },
                  _focusVisible: {
                    outline: '2px solid token(colors.primary.500)',
                    outlineOffset: '-2px',
                  },
                })}
              >
                <RiMicLine
                  size={24}
                  aria-hidden
                  className={css({ color: 'primary.600', flexShrink: 0 })}
                />
                <span
                  className={css({ minWidth: 0, overflowWrap: 'anywhere' })}
                >
                  <span>{record.title || t('library.untitled')}</span>
                  <time
                    dateTime={record.origin_at}
                    className={css({
                      display: 'block',
                      color: 'greyscale.600',
                      fontSize: '0.875rem',
                    })}
                  >
                    {new Date(record.origin_at).toLocaleString(i18n.language)}
                  </time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/meeting/notes?source_type=audio_recording"
        className={css({
          display: 'block',
          textAlign: 'center',
          padding: '1rem',
          color: 'primary.700',
        })}
      >
        {t('video.more')}
      </Link>
    </section>
  )
}

export function RecordingOverview() {
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError)) return <p role="status">{t('loading')}</p>
  const enabled = !isError && !!data?.meeting_records?.capture_audio_enabled
  return (
    <MeetingModuleShell compactNavigation>
      <main className={libraryLayout}>
        <div className={css({ md: { display: 'none' } })}>
          <MeetingModuleNav current="/meeting/recording" />
        </div>
        <h1
          className={css({
            fontSize: '1.5rem',
            fontWeight: 'bold',
            marginBottom: '1.5rem',
          })}
        >
          {t('library.record')}
        </h1>
        {enabled ? (
          <>
            <Link
              href="/meeting/recording/capture"
              className={css({
                display: 'inline-flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '1rem 2rem',
                color: 'primary.700',
                borderRadius: '0.75rem',
                backgroundColor: 'primary.100',
                _focusVisible: {
                  outline: '2px solid token(colors.primary.500)',
                  outlineOffset: '2px',
                },
              })}
            >
              <RiMicLine size={32} aria-hidden />
              {t('recordingOverview.record')}
            </Link>
            <RecordingHistory
              key={user.id}
              viewerId={user.id}
              enabled={!!data?.meeting_records?.enabled}
            />
          </>
        ) : (
          <p role="status">{t('library.unavailable')}</p>
        )}
      </main>
    </MeetingModuleShell>
  )
}
