import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useUser } from '@/features/auth'
import { useConfig } from '@/api/useConfig'
import { css } from '@/styled-system/css'
import { useResolveMeetingRecord } from '../api/fetchMeetingRecord'

/** Only load record metadata here; full media/text/AI content belongs to its detail. */
export function MeetingRecordLinks({
  roomId,
  sessionId,
}: {
  roomId: string
  sessionId?: string | null
}) {
  const { t, i18n } = useTranslation('meetings')
  const { user } = useUser()
  const { data: config } = useConfig()
  const enabled = !!config?.meeting_records?.enabled
  const result = useResolveMeetingRecord(
    user?.id,
    sessionId
      ? { room_id: roomId, meeting_session_id: sessionId }
      : { room_id: roomId },
    enabled
  )
  if (!enabled) return null
  const record = result.isError ? undefined : result.data
  return (
    <div
      className={css({ display: 'flex', flexDirection: 'column', gap: 'lg' })}
    >
      {(['notes', 'minutes'] as const).map((kind) => (
        <section
          key={kind}
          className={css({
            border: '1px solid',
            borderColor: 'border.subtle',
            borderRadius: 'control',
            padding: 'lg',
          })}
        >
          <h3>{t(`library.${kind}`)}</h3>
          {record?.title && <p>{record.title}</p>}
          {record?.origin_at && (
            <time dateTime={record.origin_at}>
              {new Date(record.origin_at).toLocaleString(i18n.language)}
            </time>
          )}
          <p>
            {result.isLoading
              ? t('loading')
              : !record
                ? t('video.materialUnavailable')
                : kind === 'notes'
                  ? t('video.recordHint')
                  : t(
                      record.has_summary
                        ? 'video.summaryReady'
                        : 'video.summaryPending'
                    )}
          </p>
          {record &&
            (kind === 'notes'
              ? record.capabilities.read_transcript
              : record.capabilities.read_summary) && (
              <Link
                data-testid={`meeting-detail-${kind}`}
                href={`/meeting/records/${record.id}${kind === 'minutes' ? '?tab=summary' : ''}`}
                className={css({ color: 'text.link' })}
              >
                {t(
                  kind === 'notes' ? 'video.viewRecord' : 'detail.viewSummary'
                )}
              </Link>
            )}
          {result.isError && (
            <button type="button" onClick={() => void result.refetch()}>
              {t('error.retry')}
            </button>
          )}
        </section>
      ))}
    </div>
  )
}
