import { useTranslation } from 'react-i18next'
import { Link, Redirect, useParams } from 'wouter'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useMeetingRecord } from '../api/fetchMeetingRecord'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { libraryLayout } from '../components/libraryStyles'

export function RecordingDetailContent({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  const { t, i18n } = useTranslation('meetings')
  const query = useMeetingRecord(viewerId, recordId, true)
  const record =
    !query.isError && query.data?.source_type === 'audio_recording'
      ? query.data
      : undefined
  if (query.isError || (query.data && !record))
    return (
      <div role="alert">
        <p>{t('library.loadError')}</p>
        <Button variant="tertiary" onPress={() => void query.refetch()}>
          {t('library.refresh')}
        </Button>
      </div>
    )
  if (!record) return <p role="status">{t('loading')}</p>
  return (
    <div
      className={css({ display: 'flex', flexDirection: 'column', gap: '1rem' })}
    >
      <h2 className={css({ fontSize: '1.5rem', overflowWrap: 'anywhere' })}>
        {record.title || t('library.untitled')}
      </h2>
      <p>
        {t('library.source.audio_recording')} ·{' '}
        <time dateTime={record.origin_at}>
          {new Date(record.origin_at).toLocaleString(i18n.language)}
        </time>
      </p>
      {record.retention_mode !== 'unknown' && (
        <p>
          {t(
            `recordingOverview.${record.retention_mode === 'text' ? 'textOnly' : 'keepAudio'}`
          )}
        </p>
      )}
      {(['notes', 'minutes'] as const).map((kind) => {
        const allowed =
          kind === 'notes'
            ? record.capabilities.read_transcript
            : record.capabilities.read_summary
        return (
          <section
            key={kind}
            className={css({
              padding: '1rem',
              border: '1px solid',
              borderColor: 'greyscale.200',
              borderRadius: '0.75rem',
            })}
          >
            <h3>{t(`library.${kind}`)}</h3>
            <p className={css({ color: 'greyscale.600', margin: '0.75rem 0' })}>
              {t(
                !allowed
                  ? 'video.materialUnavailable'
                  : kind === 'notes'
                    ? 'video.recordHint'
                    : record.has_summary
                      ? 'video.summaryReady'
                      : 'video.summaryPending'
              )}
            </p>
            {allowed && (
              <Link
                href={`/meeting/records/${encodeURIComponent(record.id)}${kind === 'minutes' ? '?tab=summary' : ''}`}
                className={css({ color: 'primary.700' })}
              >
                {t(
                  kind === 'notes' ? 'video.viewRecord' : 'detail.viewSummary'
                )}
              </Link>
            )}
          </section>
        )
      })}
    </div>
  )
}

export function RecordingDetail() {
  const { recordId } = useParams<{ recordId: string }>()
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError)) return <p role="status">{t('loading')}</p>
  return (
    <MeetingModuleShell compactNavigation>
      <main className={libraryLayout}>
        <Link
          href="/meeting/recording"
          className={css({ color: 'primary.700' })}
        >
          {t('recordingOverview.back')}
        </Link>
        <h1 className={css({ fontSize: '1.25rem', margin: '1rem 0' })}>
          {t('recordingOverview.detail')}
        </h1>
        {!isError && data?.meeting_records?.enabled && recordId ? (
          <RecordingDetailContent
            key={`${user.id}:${recordId}`}
            viewerId={user.id}
            recordId={recordId}
          />
        ) : (
          <p>{t('library.unavailable')}</p>
        )}
      </main>
    </MeetingModuleShell>
  )
}
