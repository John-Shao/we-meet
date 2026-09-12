import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, Redirect, useParams } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { Tabs, Tab, TabList, TabPanel } from '@/primitives/Tabs'
import { css } from '@/styled-system/css'
import { useMeetingRecord, useRecordSummaries } from '../api/fetchMeetingRecord'
import type {
  ApiMeetingRecord,
  ApiRecordTranscript,
  MeetingRecordPage,
} from '../api/ApiMeetingRecord'
import type {
  ApiCaptureSession,
  ApiMeetingOriginalSegment,
  ApiMeetingSpeaker,
} from '../api/ApiCaptureSession'
import {
  CaptureAudioPlayer,
  type CaptureAudioHandle,
} from '../components/CaptureAudioPlayer'
import { CaptureTranscriptionPanel } from '../components/CaptureTranscriptionPanel'
import { RecordSummaryPanel } from '../components/RecordSummaryPanel'
import { libraryLayout } from '../components/libraryStyles'

const privateOptions = { retry: false, gcTime: 0, staleTime: 0 }
const textStyle = css({
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  lineHeight: 1.7,
  margin: '0.75rem 0',
})
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

function OriginalRead({
  record,
  viewerId,
  speakers = false,
}: {
  record: ApiMeetingRecord
  viewerId: string
  speakers?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [cursors, setCursors] = useState<string[]>([''])
  const endpoint = speakers
    ? 'speakers'
    : record.source_type === 'meeting'
      ? 'transcripts'
      : 'original-segments'
  const path = `meeting-records/${record.id}/${endpoint}/?cursor=${encodeURIComponent(cursors.at(-1)!)}`
  const query = useQuery({
    ...privateOptions,
    queryKey: ['record-library-content', viewerId, record.revision, path],
    queryFn: ({ signal }) =>
      fetchApi<
        MeetingRecordPage<
          ApiRecordTranscript | ApiMeetingOriginalSegment | ApiMeetingSpeaker
        >
      >(path, { signal, cache: 'no-store' }),
    refetchInterval: (q) => (q.state.error ? false : 10000),
  })
  if (query.isError) return <p role="alert">{t('library.loadError')}</p>
  if (!query.data) return <p role="status">{t('loading')}</p>
  return (
    <div>
      {!query.data.results.length && <p>{t('library.noContent')}</p>}
      {query.data.results.map((item) => (
        <article
          key={item.id}
          className={css({
            borderBottom: '1px solid token(colors.greyscale.200)',
            padding: '0.75rem 0',
          })}
        >
          {'identity_type' in item ? (
            <p>
              {item.identity_type === 'unknown'
                ? t('library.unknownSpeaker')
                : item.label}
            </p>
          ) : (
            <>
              <p>
                {'started_at' in item
                  ? `${item.speaker_name || t('library.unknownSpeaker')} · ${new Date(item.started_at).toLocaleTimeString()}`
                  : `${item.speaker_label || t('library.unknownSpeaker')} · ${time(item.start_ms)}`}
              </p>
              <p className={textStyle}>{item.text}</p>
            </>
          )}
        </article>
      ))}
      <div
        className={css({ display: 'flex', gap: '0.75rem', marginTop: '1rem' })}
      >
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
    </div>
  )
}

function LegacySummary({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  const { t } = useTranslation('meetings')
  const query = useRecordSummaries(viewerId, recordId, true)
  if (query.isError) return <p role="alert">{t('library.loadError')}</p>
  if (!query.data) return <p role="status">{t('loading')}</p>
  return (
    <>
      {query.data.results
        .filter((item) => item.status === 'success')
        .map((item) => (
          <section key={item.id}>
            <h2 className={css({ fontWeight: 600, marginTop: '1rem' })}>
              {t('library.legacySummary')}
            </h2>
            <p className={textStyle}>{item.content}</p>
          </section>
        ))}
    </>
  )
}

/** This workspace only reads capture state; device control stays on the recorder. */
function WorkspaceContent({
  record,
  viewerId,
}: {
  record: ApiMeetingRecord
  viewerId: string
}) {
  const { t } = useTranslation('meetings')
  const [tab, setTab] = useState(
    record.capabilities.read_transcript ? 'text' : 'summary'
  )
  const player = useRef<CaptureAudioHandle>(null)
  const captureId = record.capabilities.read_transcript
    ? record.capture_id
    : null
  const capture = useQuery({
    ...privateOptions,
    queryKey: ['record-library-capture', viewerId, captureId],
    enabled: !!captureId,
    queryFn: ({ signal }) =>
      fetchApi<ApiCaptureSession>(`capture-sessions/${captureId}/`, {
        signal,
        cache: 'no-store',
      }),
    refetchInterval: (q) => (q.state.error ? false : 10000),
  })
  // Do not keep a player or billable actions alive after a failed state check.
  if (
    captureId &&
    (capture.isError || (capture.data && capture.data.record_id !== record.id))
  )
    return <p role="alert">{t('library.loadError')}</p>
  if (captureId && !capture.data) return <p role="status">{t('loading')}</p>
  const source = captureId ? capture.data : undefined
  const readableCapture = source?.status === 'stopped'
  const playable =
    readableCapture && ['saved', 'incomplete'].includes(source.media_status)
  const canReadText = record.capabilities.read_transcript
  const canReadSummary = record.capabilities.read_summary
  const selectedTab =
    (tab === 'text' || tab === 'speakers') && !canReadText
      ? 'info'
      : tab === 'summary' && !canReadSummary
        ? 'info'
        : tab
  return (
    <>
      {source && !readableCapture && (
        <div role="status" className={textStyle}>
          <p>{t('library.originalDevice')}</p>
          <Link href="/meeting/recording">{t('library.openRecorder')}</Link>
        </div>
      )}
      {playable && (
        <CaptureAudioPlayer
          key={`${viewerId}:${source.id}`}
          ref={player}
          captureId={source.id}
        />
      )}
      <Tabs
        selectedKey={selectedTab}
        onSelectionChange={(key) => setTab(String(key))}
      >
        <TabList aria-label={t('library.contentTabs')}>
          {canReadText && <Tab id="text">{t('library.text')}</Tab>}
          {canReadSummary && <Tab id="summary">{t('library.minutes')}</Tab>}
          {canReadText && record.source_type === 'audio_recording' && (
            <Tab id="speakers">{t('library.speakers')}</Tab>
          )}
          <Tab id="info">{t('library.info')}</Tab>
        </TabList>
        {canReadText && (
          <TabPanel id="text" padding="md">
            {readableCapture ? (
              <CaptureTranscriptionPanel
                key={`${viewerId}:${source.id}`}
                viewerId={viewerId}
                capture={source}
                includeSummary={false}
                onSource={(ms) => player.current?.seek(ms)}
              />
            ) : (
              <OriginalRead
                key={`${record.id}:${record.revision}`}
                record={record}
                viewerId={viewerId}
              />
            )}
          </TabPanel>
        )}
        {canReadSummary && (
          <TabPanel id="summary" padding="md">
            <RecordSummaryPanel
              showHeading={false}
              key={`${viewerId}:${record.id}`}
              viewerId={viewerId}
              recordId={record.id}
              onSourceAudio={
                playable
                  ? (ms) =>
                      player.current?.seek(
                        ms -
                          (Date.parse(source.started_at) -
                            Date.parse(record.origin_at))
                      )
                  : undefined
              }
            />
            {record.source_type === 'meeting' && (
              <LegacySummary viewerId={viewerId} recordId={record.id} />
            )}
          </TabPanel>
        )}
        {canReadText && record.source_type === 'audio_recording' && (
          <TabPanel id="speakers" padding="md">
            <p className={textStyle}>{t('library.speakersHint')}</p>
            <OriginalRead
              key={`${record.id}:${record.revision}:speakers`}
              record={record}
              viewerId={viewerId}
              speakers
            />
          </TabPanel>
        )}
        <TabPanel id="info" padding="md">
          <dl className={textStyle}>
            <dt>{t('library.sourceLabel')}</dt>
            <dd>{t(`library.source.${record.source_type}`)}</dd>
            <dt>{t('library.date')}</dt>
            <dd>{new Date(record.origin_at).toLocaleString()}</dd>
            <dt>{t('library.retentionLabel')}</dt>
            <dd>{t(`library.retention.${record.retention_mode}`)}</dd>
          </dl>
          {source && <p>{t(`library.captureStatus.${source.status}`)}</p>}
          {!record.source_available && <p>{t('library.sourceMissing')}</p>}
        </TabPanel>
      </Tabs>
    </>
  )
}

export function RecordWorkspace({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  const { t } = useTranslation('meetings')
  const query = useMeetingRecord(viewerId, recordId, true)
  return (
    <Screen>
      <main className={libraryLayout}>
        <Link href="/meeting/notes">{t('library.back')}</Link>
        {query.isError ? (
          <div role="alert">
            <p>{t('library.loadError')}</p>
            <Button variant="tertiary" onPress={() => void query.refetch()}>
              {t('library.refresh')}
            </Button>
          </div>
        ) : !query.data ? (
          <p role="status">{t('loading')}</p>
        ) : (
          <>
            <h1
              className={css({
                fontSize: '1.5rem',
                fontWeight: 700,
                margin: '1rem 0',
              })}
            >
              {query.data.title || t('library.untitled')}
            </h1>
            <p className={textStyle}>
              {t(`library.source.${query.data.source_type}`)} ·{' '}
              {new Date(query.data.origin_at).toLocaleString()}
            </p>
            <WorkspaceContent
              key={`${viewerId}:${recordId}`}
              viewerId={viewerId}
              record={query.data}
            />
          </>
        )}
      </main>
    </Screen>
  )
}

export function MeetingRecordWorkspace() {
  const { recordId } = useParams<{ recordId: string }>()
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError)) return <p role="status">{t('loading')}</p>
  if (isError || !data?.meeting_records?.enabled || !recordId)
    return (
      <Screen>
        <main className={libraryLayout}>
          <Link href="/meeting">{t('library.home')}</Link>
          <p>{t('library.unavailable')}</p>
        </main>
      </Screen>
    )
  return (
    <RecordWorkspace
      key={`${user.id}:${recordId}`}
      viewerId={user.id}
      recordId={recordId}
    />
  )
}
