import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, Redirect, useParams, useSearch } from 'wouter'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { Tabs, Tab, TabList, TabPanel } from '@/primitives/Tabs'
import { css, cx } from '@/styled-system/css'
import {
  useMeetingRecord,
  useRecordSummaries,
  useCorrectOriginalSegment,
} from '../api/fetchMeetingRecord'
import { formatClock, formatDateTime } from '../recordDateTime'
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
import {
  UploadMediaPlayer,
  type UploadMediaHandle,
} from '../components/UploadMediaPlayer'
import { TranscriptExportControl } from '../components/TranscriptExportControl'
import { CaptureTranscriptionPanel } from '../components/CaptureTranscriptionPanel'
import { UploadedRecordingStatus } from '../components/RecordingUpload'
import { HumanSummaryRevision } from '../components/HumanSummaryHistory'
import { RecordSummaryPanel } from '../components/RecordSummaryPanel'
import { RecordOverviewPanel } from '../components/RecordOverviewPanel'
import { MaterialActions } from '../components/MaterialActions'
import { mediaDuration, validMediaDuration } from '../recordMediaTiming'
import { SpeakerActivity } from '../components/SpeakerActivity'
import { RecordMediaDownload } from '../components/RecordMediaDownload'
import { RecordTrashControl } from '../components/RecordTrash'
import { RecordDocuments } from '../components/RecordDocuments'
import { TranscriptReplacementControl } from '../components/TranscriptReplacementControl'
import { TranscriptDraftScope } from '../components/TranscriptDraftScope'
import { useTranscriptDraftScope } from '../hooks/useTranscriptDraft'
import { RecordRenameControl } from '../components/RecordRenameControl'
import { StateHint } from '@/components/StateHint'
import {
  backLink,
  contentRegion,
  detailHeaderStack,
  metaLine,
  pageFixedTop,
  pageShell,
  pageTitle,
} from '../components/libraryStyles'
import { OriginalSearch } from '../components/OriginalSearch'
import { SpeakerFilter } from '../components/SpeakerFilter'
import { SpeakerAttributionControl } from '../components/SpeakerAttributionControl'
import { TranslationArchivePanel } from '../components/TranslationArchivePanel'
import { UploadTranslationPanel } from '../components/UploadTranslationPanel'
import { CaptureTranslationArchives } from '../components/CaptureTranslationArchives'
import { TranscriptSegment } from '../components/TranscriptSegment'
import { recordSourceKey } from '../recordSource'
import {
  usePlaybackFollow,
  usePlaybackResume,
  activeRowId,
  transcriptWindowTarget,
  useTranscriptFollow,
  type TranscriptPlaybackFollow,
  type TimedRow,
} from '../transcriptSync'
import { RiArrowLeftLine, RiTimeLine } from '@remixicon/react'

/** The workspace carries the clock only; each transcript derives its own rows. */
const EMPTY_ROWS: readonly TimedRow[] = []

/** 页壳与标题:与列表页同一套(铺满 + 阅读面底色)。 */
const readerShell = pageShell('default')

/** 记录标题:页面主标题一档,长标题换行到两行。 */
const recordTitleCls = cx(pageTitle, css({ overflowWrap: 'anywhere' }))

const privateOptions = { retry: false, gcTime: 0, staleTime: 0 }
const textStyle = css({
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  lineHeight: 1.7,
  marginY: 'md',
  marginX: 0,
})
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

function OriginalRead({
  record,
  viewerId,
  speakers = false,
  fullDuration,
  activeId,
  follow,
  onSource,
}: {
  record: ApiMeetingRecord
  viewerId: string
  speakers?: boolean
  fullDuration?: number
  /** Row playback is inside, so the text can follow the audio. */
  activeId?: string | null
  onSource?: (milliseconds: number) => void
  follow?: TranscriptPlaybackFollow
}) {
  const { t } = useTranslation('meetings')
  const correction = useCorrectOriginalSegment(viewerId, record.id)
  const drafts = useTranscriptDraftScope()
  const [cursors, setCursors] = useState<string[]>([''])
  const routeSearch = useSearch()
  const [search, setSearch] = useState(
    () => new URLSearchParams(routeSearch).get('q')?.slice(0, 200) ?? ''
  )
  const [speaker, setSpeaker] = useState('')
  const [anchorMs, setAnchorMs] = useState(0)
  const [following, setFollowing] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  const endpoint = speakers
    ? 'speakers'
    : record.source_type === 'meeting'
      ? 'transcripts'
      : 'original-segments'
  const path = `meeting-records/${record.id}/${endpoint}/?cursor=${encodeURIComponent(cursors.at(-1)!)}&q=${encodeURIComponent(search)}${speaker ? `&speaker=${encodeURIComponent(speaker)}` : ''}&expected_revision=${record.revision}${endpoint === 'original-segments' ? `&at_ms=${search || speaker ? 0 : anchorMs}` : ''}`
  const searchForm = !speakers && (
    <>
      <SpeakerFilter
        viewerId={viewerId}
        recordId={record.id}
        revision={record.revision}
        selected={speaker}
        onSelect={(next) => {
          setSpeaker(next)
          setCursors([''])
        }}
      />
      <OriginalSearch
        key={search}
        initialQuery={search}
        onSearch={(query) => {
          setSearch(query)
          setCursors([''])
        }}
      />
    </>
  )
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
  useEffect(() => {
    if (
      query.error instanceof ApiError &&
      [401, 403, 404].includes(query.error.statusCode)
    )
      drafts?.clear()
  }, [query.error, drafts])
  // Only capture-backed rows carry a source window in the record's clock. An
  // online transcript is stamped with wall time instead, so it cannot be followed
  // on the media timeline and contributes no rows here. Computed before the early
  // returns below so hook order cannot change.
  const rowIds: TimedRow[] = (query.data?.results ?? [])
    .filter((item): item is ApiMeetingOriginalSegment => 'start_ms' in item)
    .map((item) => ({
      id: item.id,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
    }))
  const positionMs = follow?.positionMs
  const resolvedActiveId =
    positionMs === undefined
      ? (activeId ?? null)
      : activeRowId(rowIds, positionMs)
  usePlaybackResume(follow, () => {
    setSearch('')
    setSpeaker('')
    setAnchorMs(Math.floor(positionMs ?? 0))
    setCursors([''])
    setFollowing(true)
  })
  const pauseFollowing = follow?.pauseFollowing
  useEffect(() => {
    if ((!following || search || speaker) && !speakers) pauseFollowing?.()
  }, [following, search, speaker, speakers, pauseFollowing])
  const followEnabled =
    following && follow?.enabled !== false && !search && !speaker && !speakers
  useEffect(() => {
    if (!followEnabled || positionMs === undefined || follow?.suppressed())
      return
    const target = transcriptWindowTarget(
      rowIds,
      positionMs,
      anchorMs,
      !!query.data?.next_cursor
    )
    if (target !== null) {
      setAnchorMs(target)
      setCursors([''])
    }
  }, [
    followEnabled,
    positionMs,
    follow,
    rowIds,
    anchorMs,
    query.data?.next_cursor,
  ])
  // The list scrolls the right row once per change, rather than every row asking
  // to be scrolled on the same commit.
  useTranscriptFollow({
    containerRef: listRef,
    activeId: resolvedActiveId,
    // The rows the highlight came from, so playback inside a gap still advances
    // the view rather than stalling until the next utterance starts.
    rows: rowIds,
    // Only a clock can say which row has already started; without `positionMs`
    // in `follow` this falls back to following the highlight alone.
    follow: follow ?? { suppressed: () => true, suppressionEpoch: 0 },
    enabled: followEnabled,
  })
  if (query.isError)
    return (
      <div>
        {searchForm}
        <p role="alert">
          {t(
            query.error instanceof ApiError && query.error.statusCode === 409
              ? 'library.sourceChanged'
              : 'library.loadError'
          )}
        </p>
        <Button
          variant="tertiary"
          onPress={() => {
            void client.invalidateQueries({
              queryKey: ['meeting-records', viewerId, 'detail', record.id],
            })
            void query.refetch()
          }}
        >
          {t('library.refresh')}
        </Button>
      </div>
    )
  if (!query.data)
    return (
      <div>
        {searchForm}
        <p role="status">{t('loading')}</p>
      </div>
    )
  // Only capture-backed rows carry a source window in the record's clock. An
  // online transcript is stamped with wall time instead, so it cannot be followed
  // on the media timeline and contributes no rows here.
  return (
    <div
      ref={listRef}
      onWheel={() => follow?.pauseFollowing?.()}
      onTouchMove={() => follow?.pauseFollowing?.()}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLTextAreaElement) setFollowing(false)
      }}
    >
      {searchForm}
      {positionMs !== undefined &&
        !speakers &&
        (!followEnabled || follow?.suppressed()) && (
          <Button
            variant="tertiary"
            onPress={() => {
              setSearch('')
              setSpeaker('')
              setAnchorMs(Math.floor(positionMs))
              setCursors([''])
              setFollowing(true)
              follow?.resumeFollowing?.()
            }}
          >
            {t('library.backToPlayback')}
          </Button>
        )}
      {!query.data.results.length && <p>{t('library.noContent')}</p>}
      {query.data.results.map((item) =>
        'identity_type' in item ? (
          <div
            key={item.id}
            className={cx(textStyle, css({ overflowWrap: 'anywhere' }))}
          >
            {item.identity_type === 'unknown' ? (
              t('library.unknownSpeaker')
            ) : (
              // A diarised track is a guess, so an editor can say who it really
              // was. The control is absent for a reader who may not write it,
              // and for the `unknown` track, where there is nothing to bind.
              <SpeakerAttributionControl
                recordId={record.id}
                viewerId={viewerId}
                speaker={item}
              />
            )}
            <SpeakerActivity
              activity={item.activity}
              onSeek={onSource}
              mediaDuration={fullDuration}
            />
          </div>
        ) : (
          <TranscriptSegment
            key={item.id}
            segmentId={item.id}
            active={follow !== undefined && resolvedActiveId === item.id}
            onSeek={
              'start_ms' in item && onSource
                ? () => onSource(item.start_ms)
                : undefined
            }
            speaker={
              ('started_at' in item ? item.speaker_name : item.speaker_label) ||
              t('library.unknownSpeaker')
            }
            time={
              'started_at' in item
                ? formatClock(item.started_at)
                : time(item.start_ms)
            }
            text={item.text}
            // 命中处落在正文里（服务端只负责把不匹配的行过滤掉）。
            highlight={search || undefined}
            originalText={
              'original_text' in item ? item.original_text : undefined
            }
            isCorrected={'is_corrected' in item && item.is_corrected}
            correctionRevision={
              'correction_revision' in item
                ? item.correction_revision
                : undefined
            }
            correcting={correction.isPending}
            onCorrect={
              'can_correct' in item &&
              item.can_correct &&
              item.correction_revision !== undefined
                ? (segmentId, text, expectedRevision) =>
                    correction.mutateAsync({
                      segmentId,
                      text,
                      expectedRevision,
                    })
                : undefined
            }
            onRevert={
              'can_correct' in item &&
              item.can_correct &&
              item.correction_revision !== undefined
                ? (segmentId, expectedRevision) =>
                    correction.mutateAsync({
                      segmentId,
                      expectedRevision,
                      revert: true,
                    })
                : undefined
            }
          />
        )
      )}
      <div className={css({ display: 'flex', gap: 'md', marginTop: 'lg' })}>
        {cursors.length > 1 && (
          <Button
            variant="tertiary"
            onPress={() => {
              setFollowing(false)
              setCursors((values) => values.slice(0, -1))
            }}
          >
            {t('library.previous')}
          </Button>
        )}
        {query.data.next_cursor && (
          <Button
            variant="tertiary"
            onPress={() => {
              setFollowing(false)
              setCursors((values) => [...values, query.data!.next_cursor!])
            }}
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
            <h2
              className={css({
                textStyle: 'titleMedium',
                marginTop: 'lg',
              })}
            >
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
  translations = false,
  overview = false,
  chapters = false,
}: {
  record: ApiMeetingRecord
  viewerId: string
  translations?: boolean
  overview?: boolean
  chapters?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [tab, setTab] = useState(
    chapters
      ? 'chapters'
      : overview
        ? 'summary'
        : translations &&
            (record.source_type === 'meeting' ||
              record.source_type === 'upload' ||
              record.capture_id) &&
            record.capabilities.read_transcript
          ? 'translations'
          : record.capabilities.read_transcript
            ? 'text'
            : 'summary'
  )
  const player = useRef<CaptureAudioHandle>(null)
  const uploadMedia = useRef<UploadMediaHandle>(null)
  /** Imports are served whole; captures are served as verified chunks. */
  const isUpload = record.source_type === 'upload'
  const [playerDuration, setPlayerDuration] = useState<number | null>(null)
  const fullDuration = mediaDuration(record, playerDuration)
  const canPlayUpload =
    isUpload &&
    record.capabilities.read_transcript &&
    record.capabilities.play_media === true
  /**
   * Playback position lives here because the player and the transcript are
   * separate regions: the player owns the clock, the transcript owns the text,
   * and this is the one place that connects them. The row list is empty by
   * design — the transcript derives its own active row from the position it is
   * handed, so this hook only carries the clock and the reader's scroll state.
   */
  const follow = usePlaybackFollow(EMPTY_ROWS)
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
    record.capabilities.play_media === true &&
    readableCapture &&
    ['saved', 'incomplete'].includes(source.media_status)
  const canReadText = record.capabilities.read_transcript
  /**
   * One seek entry point for both players. The two sources differ in how the
   * bytes are fetched, not in what a transcript citation means: a millisecond
   * offset in the record's own clock.
   */
  const seekTo = (milliseconds: number) => {
    if (isUpload) uploadMedia.current?.seek(milliseconds)
    else player.current?.seek(milliseconds)
  }
  const canReadSummary = record.capabilities.read_transcript
  const selectedTab =
    (tab === 'text' || tab === 'speakers' || tab === 'translations') &&
    !canReadText
      ? 'info'
      : (tab === 'summary' || tab === 'chapters') && !canReadSummary
        ? 'info'
        : tab
  return (
    <>
      {source && !readableCapture && (
        <div role="status" className={textStyle}>
          <p>{t('library.originalDevice')}</p>
          <Link href="/meeting/recording/capture">
            {t('library.openRecorder')}
          </Link>
        </div>
      )}
      <Tabs
        className={css({
          flex: '1 1 0',
          minHeight: 0,
          '& [role=tablist]': {
            overflowX: 'auto',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            borderBottom: '1px solid token(colors.border.subtle)',
          },
          '& [role=tab]': { flexShrink: 0 },
          '& [role=tab][aria-selected=false]': {
            borderBottomColor: 'transparent',
            color: 'text.secondary',
          },
          '& [role=tab][aria-selected=true]': {
            color: 'text.link',
            fontWeight: 'semibold',
          },
          '& [role=tabpanel]': {
            overflowY: 'auto',
            minHeight: 0,
            flex: '1 1 0',
          },
        })}
        selectedKey={selectedTab}
        onSelectionChange={(key) => setTab(String(key))}
      >
        <TabList aria-label={t('library.contentTabs')}>
          {canReadText && <Tab id="text">{t('library.text')}</Tab>}
          {canReadSummary && (
            <Tab id="summary">{t('recordOverview.title')}</Tab>
          )}
          {canReadSummary && (
            <Tab id="chapters">{t('recordAi.sections.chapters')}</Tab>
          )}
          {canReadText && record.source_type !== 'meeting' && (
            <Tab id="speakers">{t('library.speakers')}</Tab>
          )}
          <Tab id="info">{t('library.info')}</Tab>
          {canReadText &&
            (record.source_type === 'meeting' ||
              isUpload ||
              (captureId && record.capabilities.control_capture)) && (
              <Tab id="translations">{t('translationArchive.title')}</Tab>
            )}
        </TabList>
        {canReadText && (
          <TabPanel id="text" padding="md">
            {/* Downloads belong with the transcript they export, not only in a
                menu: the reader is looking at the text when they want the file. */}
            <TranscriptExportControl recordId={record.id} />
            {record.capabilities.batch_correct && (
              <TranscriptReplacementControl
                viewerId={viewerId}
                recordId={record.id}
              />
            )}
            {record.source_type === 'upload' && record.upload?.can_control && (
              <UploadedRecordingStatus
                recordId={record.id}
                viewerId={viewerId}
              />
            )}
            {readableCapture && record.capabilities.control_capture ? (
              <CaptureTranscriptionPanel
                key={`${viewerId}:${source.id}`}
                viewerId={viewerId}
                capture={source}
                includeSummary={false}
                compactControls
                onSource={playable ? seekTo : undefined}
                positionMs={playable ? follow.positionMs : undefined}
                activeId={follow.activeId}
                follow={playable ? follow : undefined}
              />
            ) : (
              <OriginalRead
                key={`${record.id}:${record.revision}`}
                record={record}
                viewerId={viewerId}
                activeId={
                  canPlayUpload || playable ? follow.activeId : undefined
                }
                follow={canPlayUpload || playable ? follow : undefined}
                onSource={canPlayUpload || playable ? seekTo : undefined}
              />
            )}
          </TabPanel>
        )}
        {canReadText && isUpload && (
          <TabPanel id="translations" padding="md">
            <UploadTranslationPanel
              key={`${viewerId}:${record.id}`}
              viewerId={viewerId}
              recordId={record.id}
              onSource={canPlayUpload ? seekTo : undefined}
            />
          </TabPanel>
        )}
        {canReadText && record.source_type === 'meeting' && (
          <TabPanel id="translations" padding="md">
            <TranslationArchivePanel
              key={`${viewerId}:${record.id}`}
              viewerId={viewerId}
              recordId={record.id}
            />
          </TabPanel>
        )}
        {canReadText &&
          captureId &&
          record.capabilities.control_capture &&
          record.source_type === 'audio_recording' && (
            <TabPanel id="translations" padding="md">
              <CaptureTranslationArchives
                viewerId={viewerId}
                recordId={record.id}
                captureId={captureId}
              />
            </TabPanel>
          )}
        {canReadSummary &&
          ['summary', 'chapters'].map((contentTab) => (
            <TabPanel
              key={contentTab}
              id={contentTab}
              className={css({ padding: { base: '1rem 0', md: '2rem' } })}
            >
              {contentTab === 'summary' ? (
                <RecordOverviewPanel
                  viewerId={viewerId}
                  recordId={record.id}
                  onSourceAudio={
                    canPlayUpload
                      ? seekTo
                      : playable && source
                        ? (ms) =>
                            seekTo(
                              ms -
                                (Date.parse(source.started_at) -
                                  Date.parse(record.origin_at))
                            )
                        : undefined
                  }
                />
              ) : (
                <RecordOverviewPanel
                  chaptersOnly
                  viewerId={viewerId}
                  recordId={record.id}
                  onSourceAudio={
                    canPlayUpload
                      ? seekTo
                      : playable && source
                        ? (ms) =>
                            seekTo(
                              ms -
                                (Date.parse(source.started_at) -
                                  Date.parse(record.origin_at))
                            )
                        : undefined
                  }
                />
              )}
            </TabPanel>
          ))}
        {canReadText && record.source_type !== 'meeting' && (
          <TabPanel id="speakers" padding="md">
            <p className={textStyle}>{t('library.speakersHint')}</p>
            <p className={textStyle}>{t('speakerActivity.basis')}</p>
            <OriginalRead
              key={`${record.id}:${record.revision}:speakers`}
              record={record}
              viewerId={viewerId}
              onSource={playable || canPlayUpload ? seekTo : undefined}
              speakers
              fullDuration={fullDuration}
            />
          </TabPanel>
        )}
        <TabPanel id="info" padding="md">
          <RecordTrashControl
            key={`${viewerId}:${record.id}`}
            viewerId={viewerId}
            record={record}
          />
          {record.capabilities.download_media && (
            <RecordMediaDownload
              key={`${viewerId}:${record.id}:${record.revision}`}
              record={record}
            />
          )}
          <dl
            className={css({
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: '2xl',
              rowGap: '1.25rem',
              paddingY: 'lg',
              paddingX: 0,
              '& dt': { color: 'text.secondary' },
            })}
          >
            <dt>{t('library.table.owner')}</dt>
            <dd>{record.owner?.trim() || t('library.ownerUnknown')}</dd>
            <dt>{t('library.table.created')}</dt>
            <dd>
              {record.created_at
                ? formatDateTime(record.created_at)
                : t('library.ownerUnknown')}
            </dd>
            <dt>{t('mediaTiming.title')}</dt>
            <dd>
              {fullDuration ? time(fullDuration) : t('mediaTiming.unknown')}
            </dd>
            {record.media_timing?.basis === 'partial_audio' &&
              validMediaDuration(record.media_timing.saved_duration_ms) && (
                <>
                  <dt>{t('mediaTiming.saved')}</dt>
                  <dd>
                    {time(record.media_timing.saved_duration_ms)} —{' '}
                    {t('mediaTiming.partial')}
                  </dd>
                </>
              )}
            <dt>{t('library.sourceLabel')}</dt>
            <dd>{t(recordSourceKey(record))}</dd>
            <dt>{t('library.date')}</dt>
            <dd>{formatDateTime(record.origin_at)}</dd>
            <dt>{t('library.retentionLabel')}</dt>
            <dd>{t(`library.retention.${record.retention_mode}`)}</dd>
          </dl>
          {source && <p>{t(`library.captureStatus.${source.status}`)}</p>}
          {!record.source_available && <p>{t('library.sourceMissing')}</p>}
          {record.capabilities.read_summary && (
            <RecordDocuments
              key={`${viewerId}:${record.id}`}
              viewerId={viewerId}
              recordId={record.id}
            />
          )}
        </TabPanel>
      </Tabs>
      {playable && (
        <div
          className={css({
            flexShrink: 0,
            backgroundColor: 'surface.default',
            borderTop: '1px solid token(colors.border.subtle)',
          })}
        >
          <CaptureAudioPlayer
            key={`${viewerId}:${source.id}`}
            ref={player}
            captureId={source.id}
            compact
            onPosition={follow.report}
            followControl={
              selectedTab === 'text'
                ? {
                    enabled: follow.enabled,
                    onToggle: follow.enabled
                      ? follow.pauseFollowing
                      : follow.resumeFollowing,
                  }
                : undefined
            }
          />
        </div>
      )}
      {/*
        An import has no capture playlist to read, so it gets its own player:
        the whole sealed object, with the browser's Range handling for seeking.
        The signed URL expires, which is why this mounts only with the transcript
        and re-resolves per record rather than being held for the page's life.
      */}
      {canPlayUpload && canReadText && (
        <UploadMediaPlayer
          key={`${viewerId}:${record.id}`}
          ref={uploadMedia}
          recordId={record.id}
          onDuration={setPlayerDuration}
          onPosition={follow.report}
          followControl={
            selectedTab === 'text'
              ? {
                  enabled: follow.enabled,
                  onToggle: follow.enabled
                    ? follow.pauseFollowing
                    : follow.resumeFollowing,
                }
              : undefined
          }
        />
      )}
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
  const search = new URLSearchParams(useSearch())
  // Preserve invalid/empty selectors so the API rejects them instead of opening latest.
  const humanIds = search.getAll('human')
  const humanId = humanIds.length
    ? humanIds.length > 1 || search.has('summary')
      ? ''
      : humanIds[0]
    : undefined
  const summaryIds = search.getAll('summary')
  const summaryId = summaryIds.length > 1 ? '' : summaryIds[0]
  const translations = search.get('tab') === 'translations'
  const summary = search.get('tab') === 'summary'
  const chapters = search.get('tab') === 'chapters'
  const overview = search.get('tab') === 'overview'
  const document =
    summary ||
    summaryId !== undefined ||
    humanId !== undefined ||
    search.get('review') === 'true'
  const query = useMeetingRecord(viewerId, recordId, true)
  /**
   * 权限被撤销(401/403/404)时**不能再显示任何私有内容** —— 连标题都不行。
   * react-query 在重取失败后仍保留上一次的 `data`,所以这里不能只看 `data`:
   * 页头在工作区上方,一旦漏掉这个判断,标题会跟着错误页一起留在屏幕上。
   */
  const record = query.isError ? undefined : query.data
  return (
    <Screen>
      <main className={readerShell}>
        {/* 工作区页头(返回 + 标题 + 元信息)钉住;滚动交给内部各面板
            (Tabs 的 tabpanel 自己 overflow),所以内容区不带滚动。 */}
        <div className={pageFixedTop}>
          <div className={detailHeaderStack}>
            <Link
              href={document ? '/meeting/minutes' : '/meeting/notes'}
              className={backLink}
            >
              <RiArrowLeftLine size={20} aria-hidden />
              {t(document ? 'minutesLibrary.back' : 'library.back')}
            </Link>
            {record && (
              <div
                className={css({
                  display: 'flex',
                  gap: 'md',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                })}
              >
                <h1 className={recordTitleCls}>
                  {document
                    ? t('recordOverview.documentTitle', {
                        title: record.title || t('library.untitled'),
                      })
                    : record.title || t('library.untitled')}
                </h1>
                {!document && record.capabilities.rename && (
                  <RecordRenameControl
                    viewerId={viewerId}
                    recordId={record.id}
                    title={record.title}
                  />
                )}
                {(document
                  ? record.capabilities.read_summary
                  : record.capabilities.read_transcript) && (
                  <MaterialActions
                    key={`${viewerId}:${record.id}:${document}`}
                    recordId={record.id}
                    viewerId={viewerId}
                    scope={document ? 'minutes' : 'record'}
                    title={record.title || t('library.untitled')}
                    originAt={record.origin_at}
                  />
                )}
              </div>
            )}
            {record && (
              <p className={metaLine}>
                <RiTimeLine size={16} aria-hidden />
                {t(recordSourceKey(record))} ·{' '}
                {formatDateTime(record.origin_at)}
              </p>
            )}
          </div>
        </div>
        <div className={contentRegion}>
          {query.isError ? (
            <StateHint
              state="error"
              action={
                <Button
                  variant="tertiary"
                  size="sm"
                  onPress={() => void query.refetch()}
                >
                  {t('library.refresh')}
                </Button>
              }
            >
              {t('library.loadError')}
            </StateHint>
          ) : !record ? (
            <StateHint state="loading">{t('loading')}</StateHint>
          ) : document ? (
            <div
              className={css({
                overflowY: 'auto',
                minHeight: 0,
                flex: '1 1 0',
                padding: { base: 'lg', md: '2xl' },
              })}
            >
              <h2
                className={css({
                  textStyle: 'headlineLarge',
                  marginBottom: 'lg',
                  overflowWrap: 'anywhere',
                })}
              >
                {t('recordOverview.documentTitle', {
                  title: record.title || t('library.untitled'),
                })}
              </h2>
              <p className={metaLine}>
                {record.owner?.trim() || t('library.ownerUnknown')} ·{' '}
                {formatDateTime(record.origin_at)}
              </p>
              {record.capabilities.read_transcript && (
                <Link href={`/meeting/records/${record.id}?tab=overview`}>
                  {t('recordOverview.backToRecord')}
                </Link>
              )}
              {!record.capabilities.read_summary ? (
                <StateHint>{t('recordAi.unavailable')}</StateHint>
              ) : humanId !== undefined ? (
                <HumanSummaryRevision
                  key={`${viewerId}:${record.id}:${humanId}`}
                  viewerId={viewerId}
                  recordId={record.id}
                  versionId={humanId}
                  canReadTranscript={record.capabilities.read_transcript}
                  linked
                />
              ) : (
                <>
                  <RecordSummaryPanel
                    key={`${viewerId}:${record.id}:${summaryId ?? 'latest'}:${search.get('review')}`}
                    showHeading={false}
                    selectedVersionId={summaryId}
                    viewerId={viewerId}
                    recordId={record.id}
                  />
                  {summaryId === undefined &&
                    record.source_type === 'meeting' && (
                      <LegacySummary viewerId={viewerId} recordId={record.id} />
                    )}
                </>
              )}
            </div>
          ) : (
            <TranscriptDraftScope
              key={`${viewerId}:${recordId}:${record.capabilities.read_transcript}`}
            >
              <WorkspaceContent
                key={`${viewerId}:${recordId}:${translations}:${overview}:${chapters}`}
                viewerId={viewerId}
                record={record}
                translations={translations}
                overview={overview}
                chapters={chapters}
              />
            </TranscriptDraftScope>
          )}
        </div>
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
  if (!user || (!data && !isError))
    return <StateHint state="loading">{t('loading')}</StateHint>
  if (isError || !data?.meeting_records?.enabled || !recordId)
    return (
      <Screen>
        <main className={readerShell}>
          <div className={contentRegion}>
            <StateHint
              state="empty"
              action={
                <Link href="/meeting" className={backLink}>
                  {t('library.home')}
                </Link>
              }
            >
              {t('library.unavailable')}
            </StateHint>
          </div>
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
