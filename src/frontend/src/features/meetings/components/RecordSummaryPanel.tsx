import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { ApiError } from '@/api/ApiError'
import { StateHint } from '@/components/StateHint'
import { Button, H, Text } from '@/primitives'
import { css } from '@/styled-system/css'

import {
  useMeetingRecord,
  useMeetingRecords,
  useRecordSummaryJob,
  useRecordSummaryVersions,
  useRecordTranscriptVersion,
  useRequestRecordSummary,
  type SummaryRequestPayload,
} from '../api/fetchMeetingRecord'
import type {
  ApiRecordSummaryVersion,
  RecordSourceReference,
  SummaryStage,
} from '../api/ApiMeetingRecord'
import { SummaryAutomationControl } from './SummaryAutomationControl'
import { HumanSummaryPanel } from './HumanSummaryPanel'
import { RecordQuestionPanel } from './RecordQuestionPanel'
import { SummaryExportControl } from './SummaryExportControl'
import { SummaryNotificationPanel } from './SummaryNotificationPanel'
import { SummarySharingControl } from './SummarySharingControl'
import { isSummaryPayload, useSummaryIntent } from '../hooks/useSummaryIntent'

export const RecordSummaryPanel = (
  props: ComponentProps<typeof RecordSummaryPanelContent>
) => (
  <RecordSummaryPanelContent
    key={JSON.stringify([props.viewerId, props.recordId])}
    {...props}
  />
)

const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  '&[hidden]': { display: 'none' },
})

export const RoomRecordSummaries = ({
  roomId,
  viewerId,
}: {
  roomId: string
  viewerId: string
}) => {
  const { t } = useTranslation('meetings')
  const [cursor, setCursor] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const records = useMeetingRecords(viewerId, true, { room_id: roomId, cursor })
  if (records.isError)
    return <StateHint state="error">{t('recordAi.unavailable')}</StateHint>
  if (!records.data)
    return <StateHint state="loading">{t('loading')}</StateHint>
  if (selected)
    return (
      <div className={stack}>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => setSelected(undefined)}
        >
          {t('recordAi.back')}
        </Button>
        <RecordSummaryPanel
          key={`${viewerId}:${selected}`}
          viewerId={viewerId}
          recordId={selected}
        />
      </div>
    )
  return (
    <div className={stack}>
      <Text>{t('recordAi.chooseSession')}</Text>
      {!records.data.results.some(
        (record) => record.capabilities.read_summary
      ) && <StateHint>{t('recordAi.noRecords')}</StateHint>}
      {records.data.results
        .filter((record) => record.capabilities.read_summary)
        .map((record) => (
          <Button
            key={record.id}
            variant="tertiary"
            onPress={() => setSelected(record.id)}
          >
            {record.title} · {new Date(record.origin_at).toLocaleString()}
          </Button>
        ))}
      {records.data.next_cursor && (
        <Button
          variant="tertiary"
          onPress={() => setCursor(records.data.next_cursor!)}
        >
          {t('recordAi.moreSessions')}
        </Button>
      )}
      {cursor && (
        <Button variant="tertiary" onPress={() => setCursor(undefined)}>
          {t('recordAi.firstPage')}
        </Button>
      )}
    </div>
  )
}

const RecordSummaryPanelContent = ({
  recordId,
  viewerId,
  onSourceAudio,
  showHeading = true,
  selectedVersionId,
  duringCapture = false,
}: {
  recordId: string
  viewerId: string
  onSourceAudio?: (milliseconds: number) => void
  showHeading?: boolean
  selectedVersionId?: string
  duringCapture?: boolean
}) => {
  const { t } = useTranslation('meetings')
  const detail = useMeetingRecord(viewerId, recordId, true)
  const allowed = !!detail.data?.capabilities.read_summary && !detail.isError
  const progress = useRecordSummaryJob(viewerId, recordId, allowed)
  const [cursor, setCursor] = useState<string>()
  const pinned = selectedVersionId !== undefined
  const versions = useRecordSummaryVersions(
    viewerId,
    recordId,
    allowed,
    cursor,
    selectedVersionId
  )
  const mutation = useRequestRecordSummary(viewerId, recordId)
  const recovery = useSummaryIntent(
    'summary',
    viewerId,
    recordId,
    isSummaryPayload
  )
  const pendingIntent = recovery.pending
  const inFlight = useRef(false)
  const [message, setMessage] = useState('')
  const [tool, setTool] = useState<string>()
  const [citation, setCitation] = useState<{
    snapshotId: string
    ref: RecordSourceReference
  }>()
  const original = useRecordTranscriptVersion(
    viewerId,
    recordId,
    citation?.snapshotId,
    allowed && !!detail.data?.capabilities.read_transcript
  )
  const job = progress.data?.job
  const busy = job?.status === 'queued' || job?.status === 'running'
  const canGenerate = detail.data?.capabilities.generate_summary
  const ready = progress.data?.generation_ready
  const staged = progress.data?.staged_summaries_enabled
  const readyStages = progress.data?.ready_stages ?? []
  const { refetch: refreshVersions } = versions
  useEffect(() => {
    if (allowed) void refreshVersions()
  }, [
    allowed,
    job?.id,
    job?.attempt,
    job?.status,
    job?.updated_at,
    refreshVersions,
  ])

  const submit = async (
    operation: SummaryRequestPayload['operation'],
    stage?: SummaryStage
  ) => {
    if (inFlight.current || !progress.data || !recovery.ready) return
    inFlight.current = true
    setMessage('')
    let intent: NonNullable<typeof pendingIntent>
    try {
      intent = recovery.getOrCreate({
        operation,
        ...(stage ? { stage } : {}),
        expected_revision: progress.data.revision,
        expected_job_id: job?.id ?? null,
        expected_attempt: job?.attempt ?? null,
      })
    } catch {
      inFlight.current = false
      return
    }
    try {
      await mutation.mutateAsync(intent)
      if (recovery.resolve(intent)) setMessage('recordAi.accepted')
      setCursor(undefined)
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 429) {
        setMessage('recordAi.rateLimited')
      } else if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409, 422].includes(error.statusCode)
      ) {
        recovery.resolve(intent)
        setMessage(
          error.statusCode === 409
            ? 'recordAi.conflict'
            : 'recordAi.requestDenied'
        )
      } else setMessage('recordAi.uncertain')
      await Promise.allSettled([
        detail.refetch(),
        progress.refetch(),
        versions.refetch(),
      ])
    } finally {
      inFlight.current = false
    }
  }

  if (detail.isError || progress.isError)
    return <StateHint state="error">{t('recordAi.unavailable')}</StateHint>
  if (versions.isError)
    return (
      <div className={stack}>
        <StateHint state="error">
          {t(
            pinned ? 'summaryNotice.versionUnavailable' : 'recordAi.unavailable'
          )}
        </StateHint>
        {pinned && (
          <Link
            href={`/meeting/records/${encodeURIComponent(recordId)}?tab=summary`}
          >
            {t('summaryNotice.allVersions')}
          </Link>
        )}
      </div>
    )
  if (!detail.data || (allowed && (!progress.data || !versions.data)))
    return <StateHint state="loading">{t('loading')}</StateHint>
  if (!allowed) return <StateHint>{t('recordAi.unavailable')}</StateHint>

  const source = original.data?.segments.find(
    (segment) =>
      citation &&
      segment.segment_id === citation.ref.segment_id &&
      segment.segment_revision === citation.ref.segment_revision &&
      segment.start_ms === citation.ref.start_ms &&
      segment.end_ms === citation.ref.end_ms
  )
  const primaryVersion =
    versions.data?.results.find((version) => version.is_current) ??
    versions.data?.results[0]
  const otherVersions =
    versions.data?.results.filter(
      (version) => version.id !== primaryVersion?.id
    ) ?? []
  return (
    <div className={stack}>
      {showHeading && (
        <>
          <H lvl={2}>{detail.data.title}</H>
          <Text>{new Date(detail.data.origin_at).toLocaleString()}</Text>
        </>
      )}
      {pinned && (
        <div className={stack}>
          <Text>{t('summaryNotice.pinned')}</Text>
          <Link
            href={`/meeting/records/${encodeURIComponent(recordId)}?tab=summary`}
          >
            {t('summaryNotice.allVersions')}
          </Link>
        </div>
      )}
      {!duringCapture && (
        <div
          role="group"
          aria-label={t('minutesReader.tools')}
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            paddingBottom: '0.75rem',
            borderBottom: '1px solid token(colors.greyscale.200)',
          })}
        >
          {(['ask', 'edit', 'share', 'notify', 'manage'] as const)
            .filter(
              (value) =>
                (value !== 'ask' || detail.data.capabilities.read_transcript) &&
                (!pinned || !['edit', 'manage'].includes(value))
            )
            .map((value) => (
              <Button
                key={value}
                size="sm"
                variant="tertiary"
                aria-pressed={tool === value}
                onPress={() => setTool(tool === value ? undefined : value)}
              >
                {t(`minutesReader.${value}`)}
              </Button>
            ))}
        </div>
      )}
      <div hidden={!duringCapture && tool !== 'notify'}>
        {!duringCapture && (
          <SummaryNotificationPanel
            recordId={recordId}
            viewerId={viewerId}
            summaryId={selectedVersionId}
          />
        )}
      </div>
      <div hidden={!duringCapture && tool !== 'share'}>
        {!duringCapture && (
          <SummarySharingControl
            recordId={recordId}
            viewerId={viewerId}
            online={detail.data.source_type === 'meeting'}
          />
        )}
      </div>
      <div
        className={stack}
        hidden={
          !duringCapture &&
          !!primaryVersion &&
          tool !== 'manage' &&
          !pendingIntent &&
          !busy &&
          !message
        }
      >
        {!pinned && (
          <SummaryAutomationControl recordId={recordId} viewerId={viewerId} />
        )}
        {!pinned && job && (
          <div role="status">
            {t(`recordAi.status.${job.status}`)}
            {job.dispatch_pending && ` · ${t('recordAi.dispatchPending')}`}
            {busy &&
              job.chunk_progress &&
              ` · ${t('recordAi.chunkProgress', job.chunk_progress)}`}
          </div>
        )}
        {!pinned && canGenerate && (
          <div
            className={css({
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
            })}
          >
            {pendingIntent ? (
              <Button
                size="sm"
                isDisabled={mutation.isPending || !recovery.ready}
                onPress={() => void submit(pendingIntent.payload.operation)}
              >
                {t('recordAi.resubmit')}
              </Button>
            ) : (
              <>
                {staged ? (
                  readyStages.map((stage) => (
                    <Button
                      key={stage}
                      size="sm"
                      isDisabled={busy || mutation.isPending || !recovery.ready}
                      onPress={() =>
                        void submit(job ? 'regenerate' : 'generate', stage)
                      }
                    >
                      {t(`recordAi.generateStage.${stage}`)}
                    </Button>
                  ))
                ) : (
                  <Button
                    size="sm"
                    isDisabled={
                      !ready || busy || mutation.isPending || !recovery.ready
                    }
                    onPress={() => void submit(job ? 'regenerate' : 'generate')}
                  >
                    {t(job ? 'recordAi.regenerate' : 'recordAi.generate')}
                  </Button>
                )}
                {job?.retryable && !busy && (
                  <Button
                    size="sm"
                    variant="tertiary"
                    isDisabled={mutation.isPending || !recovery.ready}
                    onPress={() =>
                      void submit('retry', staged ? job.stage : undefined)
                    }
                  >
                    {t('recordAi.retry')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        {message && <div role="status">{t(message)}</div>}
        {!pinned && canGenerate && recovery.failed && (
          <div role="status">
            <Text>{t('recordAi.recoveryError')}</Text>
            <Button size="sm" variant="tertiary" onPress={recovery.reload}>
              {t('recordAi.refresh')}
            </Button>
          </div>
        )}
        {!pinned &&
          progress.data?.blocked_reason === 'source_budget_exceeded' && (
            <Text>{t('recordAi.sourceBudgetExceeded')}</Text>
          )}
        {!pinned &&
          canGenerate &&
          !progress.data?.blocked_reason &&
          (staged ? readyStages.length === 0 : !ready) && (
            <Text>
              {t(
                staged
                  ? 'recordAi.waitForStableSource'
                  : 'recordAi.waitForSource'
              )}
            </Text>
          )}
        {!pinned && staged && progress.data?.next_update_at && (
          <Text>
            {t('recordAi.nextUpdate', {
              time: new Date(progress.data.next_update_at).toLocaleTimeString(),
            })}
          </Text>
        )}
      </div>
      <div hidden={!duringCapture && tool !== 'edit'}>
        {!pinned && !duringCapture && (
          <HumanSummaryPanel
            key={`human:${viewerId}:${recordId}`}
            recordId={recordId}
            viewerId={viewerId}
            versions={versions.data?.results ?? []}
            onSource={
              detail.data.capabilities.read_transcript
                ? (snapshotId, ref) => setCitation({ snapshotId, ref })
                : undefined
            }
          />
        )}
      </div>
      {versions.data?.results.length === 0 && (
        <StateHint>{t('recordAi.noVersions')}</StateHint>
      )}
      <div hidden={!duringCapture && tool !== 'ask'}>
        {!duringCapture && detail.data.capabilities.read_transcript && (
          <RecordQuestionPanel
            key={`question:${viewerId}:${recordId}`}
            recordId={recordId}
            viewerId={viewerId}
            versions={versions.data?.results ?? []}
            onSource={(snapshotId, ref) => setCitation({ snapshotId, ref })}
          />
        )}
      </div>
      {primaryVersion && (
        <Version
          key={primaryVersion.id}
          version={primaryVersion}
          recordId={recordId}
          viewerId={viewerId}
          duringCapture={duringCapture}
          onSource={
            detail.data.capabilities.read_transcript
              ? (ref) =>
                  setCitation({
                    snapshotId: primaryVersion.input_snapshot_id,
                    ref,
                  })
              : undefined
          }
        />
      )}
      {(otherVersions.length > 0 || versions.data?.next_cursor || cursor) && (
        <details
          className={css({
            paddingTop: '1rem',
            borderTop: '1px solid token(colors.greyscale.200)',
          })}
        >
          <summary
            className={css({
              cursor: 'pointer',
              fontWeight: 600,
              paddingBottom: '1rem',
            })}
          >
            {t('minutesReader.history')}
          </summary>
          {otherVersions.map((version) => (
            <Version
              key={version.id}
              version={version}
              recordId={recordId}
              viewerId={viewerId}
              duringCapture={duringCapture}
              onSource={
                detail.data.capabilities.read_transcript
                  ? (ref) =>
                      setCitation({
                        snapshotId: version.input_snapshot_id,
                        ref,
                      })
                  : undefined
              }
            />
          ))}
          {versions.data?.next_cursor && (
            <Button
              variant="tertiary"
              onPress={() => setCursor(versions.data!.next_cursor!)}
            >
              {t('recordAi.older')}
            </Button>
          )}
          {cursor && (
            <Button variant="tertiary" onPress={() => setCursor(undefined)}>
              {t('recordAi.latest')}
            </Button>
          )}
        </details>
      )}
      <Button
        size="sm"
        variant="tertiary"
        onPress={() =>
          void Promise.allSettled([
            detail.refetch(),
            progress.refetch(),
            versions.refetch(),
          ])
        }
      >
        {t('recordAi.refresh')}
      </Button>
      {citation && detail.data.capabilities.read_transcript && (
        <section className={stack} aria-label={t('recordAi.source')}>
          <H lvl={3}>{t('recordAi.source')}</H>
          {original.isError ? (
            <Text>{t('recordAi.unavailable')}</Text>
          ) : original.isLoading ? (
            <Text>{t('loading')}</Text>
          ) : (
            <Text>{source?.text ?? t('recordAi.sourceMissing')}</Text>
          )}
          {!duringCapture &&
            onSourceAudio &&
            source &&
            !original.isError &&
            !original.isFetching && (
              <Button
                variant="tertiary"
                onPress={() => onSourceAudio(source.start_ms)}
              >
                {t('recordAi.listenSource')}
              </Button>
            )}
          <Button variant="tertiary" onPress={() => setCitation(undefined)}>
            {t('recordAi.closeSource')}
          </Button>
        </section>
      )}
    </div>
  )
}

const Version = ({
  version,
  recordId,
  viewerId,
  onSource,
  duringCapture,
}: {
  version: ApiRecordSummaryVersion
  recordId: string
  viewerId: string
  onSource?: (ref: RecordSourceReference) => void
  duringCapture?: boolean
}) => {
  const { t } = useTranslation('meetings')
  return (
    <article
      className={css({
        padding: '0.5rem 0',
        '& p': { lineHeight: 1.85, overflowWrap: 'anywhere' },
      })}
    >
      <div className={stack}>
        <p className={css({ color: 'greyscale.600', fontSize: '0.8125rem' })}>
          {version.stage && `${t(`recordAi.stage.${version.stage}`)} · `}
          {t('minutesReader.generatedAt')}{' '}
          {new Date(version.created_at).toLocaleString()} ·{' '}
          {t(version.is_current ? 'recordAi.current' : 'recordAi.historical')}
        </p>
        {version.stage && version.stage !== 'final' && (
          <Text variant="note">{t('recordAi.provisional')}</Text>
        )}
        {version.asr_status === 'incomplete' && (
          <Text variant="note">{t('recordAi.asr.incomplete')}</Text>
        )}
        <details open={duringCapture}>
          <summary
            className={css({
              cursor: 'pointer',
              color: 'greyscale.600',
              fontSize: '0.8125rem',
            })}
          >
            {t('minutesReader.sourceInfo')}
          </summary>
          {version.source_through_ms !== undefined && (
            <Text variant="note">
              {t('recordAi.observedThrough', {
                time: `${Math.floor(version.source_through_ms / 60000)}:${String(Math.floor(version.source_through_ms / 1000) % 60).padStart(2, '0')}`,
              })}
            </Text>
          )}
          <Text variant="note">
            {t(`recordAi.delivery.${version.delivery_status}`)} ·{' '}
            {t('recordAi.coverageUnverified')}
          </Text>
          {version.asr_status &&
            !['unverified', 'incomplete'].includes(version.asr_status) && (
              <Text variant="note">
                {t(`recordAi.asr.${version.asr_status}`)}
              </Text>
            )}
        </details>
        <section
          className={css({
            padding: '1.25rem',
            borderRadius: '1rem',
            backgroundColor: 'surface.canvas',
          })}
        >
          <h3
            className={css({
              fontSize: '1.25rem',
              fontWeight: 700,
              marginBottom: '0.75rem',
            })}
          >
            {t('minutesReader.overview')}
          </h3>
          <Text>{version.content.overview}</Text>
        </section>
        {(
          ['decisions', 'action_items', 'chapters', 'open_questions'] as const
        ).map(
          (kind) =>
            version.content[kind].length > 0 && (
              <details
                key={kind}
                open
                className={css({ padding: '0.75rem 0' })}
              >
                <summary
                  className={css({
                    cursor: 'pointer',
                    fontSize: '1.125rem',
                    fontWeight: 600,
                    marginBottom: '1rem',
                  })}
                >
                  {t(`recordAi.sections.${kind}`)}{' '}
                  <span
                    className={css({
                      color: 'greyscale.500',
                      fontSize: '0.875rem',
                      marginLeft: '0.5rem',
                    })}
                  >
                    {version.content[kind].length}
                  </span>
                </summary>
                <ul>
                  {version.content[kind].map((point, index) => (
                    <li
                      key={index}
                      className={css({
                        marginBottom: '1rem',
                        padding: '0.25rem 0 0.25rem 1rem',
                        borderLeft: '2px solid token(colors.primary.200)',
                      })}
                    >
                      <Text>{point.text}</Text>
                      {'owner_text' in point && (
                        <Text variant="note">
                          {[point.owner_text, point.due_text]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      )}
                      {onSource &&
                        point.source_refs.map((ref, i) => (
                          <Button
                            key={i}
                            size="sm"
                            variant="tertiary"
                            onPress={() => onSource(ref)}
                          >
                            {t('recordAi.source')}{' '}
                            {Math.floor(ref.start_ms / 60000)}:
                            {String(
                              Math.floor(ref.start_ms / 1000) % 60
                            ).padStart(2, '0')}
                          </Button>
                        ))}
                    </li>
                  ))}
                </ul>
              </details>
            )
        )}
        {!duringCapture && (
          <details>
            <summary
              className={css({
                cursor: 'pointer',
                color: 'primary.700',
                padding: '0.75rem 0',
              })}
            >
              {t('minutesReader.export')}
            </summary>
            <SummaryExportControl
              recordId={recordId}
              viewerId={viewerId}
              sourceId={version.id}
              sourceKind="ai"
            />
          </details>
        )}
      </div>
    </article>
  )
}
