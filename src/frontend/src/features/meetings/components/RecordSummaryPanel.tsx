import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

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

const stack = css({ display: 'flex', flexDirection: 'column', gap: '1rem' })

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

export const RecordSummaryPanel = ({
  recordId,
  viewerId,
}: {
  recordId: string
  viewerId: string
}) => {
  const { t } = useTranslation('meetings')
  const detail = useMeetingRecord(viewerId, recordId, true)
  const allowed = !!detail.data?.capabilities.read_summary && !detail.isError
  const progress = useRecordSummaryJob(viewerId, recordId, allowed)
  const [cursor, setCursor] = useState<string>()
  const versions = useRecordSummaryVersions(viewerId, recordId, allowed, cursor)
  const mutation = useRequestRecordSummary(viewerId, recordId)
  const [pendingIntent, setPendingIntent] = useState<{
    key: string
    payload: SummaryRequestPayload
  }>()
  const inFlight = useRef(false)
  const [message, setMessage] = useState('')
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
    if (inFlight.current || !progress.data) return
    inFlight.current = true
    const intent = pendingIntent ?? {
      key: crypto.randomUUID(),
      payload: {
        operation,
        ...(stage ? { stage } : {}),
        expected_revision: progress.data.revision,
        expected_job_id: job?.id ?? null,
        expected_attempt: job?.attempt ?? null,
      },
    }
    setPendingIntent(intent)
    setMessage('')
    try {
      await mutation.mutateAsync(intent)
      setPendingIntent(undefined)
      setMessage('recordAi.accepted')
      setCursor(undefined)
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 429) {
        setMessage('recordAi.rateLimited')
      } else if (error instanceof ApiError && error.statusCode < 500) {
        setPendingIntent(undefined)
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

  if (detail.isError || progress.isError || versions.isError)
    return <StateHint state="error">{t('recordAi.unavailable')}</StateHint>
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
  return (
    <div className={stack}>
      <H lvl={2}>{detail.data.title}</H>
      <Text>{new Date(detail.data.origin_at).toLocaleString()}</Text>
      <SummaryAutomationControl recordId={recordId} viewerId={viewerId} />
      {job && (
        <div role="status">
          {t(`recordAi.status.${job.status}`)}
          {job.dispatch_pending && ` · ${t('recordAi.dispatchPending')}`}
          {busy &&
            job.chunk_progress &&
            ` · ${t('recordAi.chunkProgress', job.chunk_progress)}`}
        </div>
      )}
      {canGenerate && (
        <div
          className={css({ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' })}
        >
          {pendingIntent ? (
            <Button
              size="sm"
              isDisabled={mutation.isPending}
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
                    isDisabled={busy || mutation.isPending}
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
                  isDisabled={!ready || busy || mutation.isPending}
                  onPress={() => void submit(job ? 'regenerate' : 'generate')}
                >
                  {t(job ? 'recordAi.regenerate' : 'recordAi.generate')}
                </Button>
              )}
              {job?.retryable && !busy && (
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={mutation.isPending}
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
      {progress.data?.blocked_reason === 'source_budget_exceeded' && (
        <Text>{t('recordAi.sourceBudgetExceeded')}</Text>
      )}
      {canGenerate &&
        !progress.data?.blocked_reason &&
        (staged ? readyStages.length === 0 : !ready) && (
          <Text>
            {t(
              staged ? 'recordAi.waitForStableSource' : 'recordAi.waitForSource'
            )}
          </Text>
        )}
      {staged && progress.data?.next_update_at && (
        <Text>
          {t('recordAi.nextUpdate', {
            time: new Date(progress.data.next_update_at).toLocaleTimeString(),
          })}
        </Text>
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
      <HumanSummaryPanel
        key={`${viewerId}:${recordId}`}
        recordId={recordId}
        viewerId={viewerId}
        versions={versions.data?.results ?? []}
        onSource={
          detail.data.capabilities.read_transcript
            ? (snapshotId, ref) => setCitation({ snapshotId, ref })
            : undefined
        }
      />
      {versions.data?.results.length === 0 && (
        <StateHint>{t('recordAi.noVersions')}</StateHint>
      )}
      {versions.data?.results.map((version) => (
        <Version
          key={version.id}
          version={version}
          onSource={
            detail.data.capabilities.read_transcript
              ? (ref) =>
                  setCitation({ snapshotId: version.input_snapshot_id, ref })
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
  onSource,
}: {
  version: ApiRecordSummaryVersion
  onSource?: (ref: RecordSourceReference) => void
}) => {
  const { t } = useTranslation('meetings')
  return (
    <article
      className={css({
        border: '1px solid',
        borderColor: 'greyscale.200',
        borderRadius: '8px',
        padding: '1rem',
      })}
    >
      <div className={stack}>
        <H lvl={3}>
          {version.stage && `${t(`recordAi.stage.${version.stage}`)} · `}
          {new Date(version.created_at).toLocaleString()} ·{' '}
          {t(version.is_current ? 'recordAi.current' : 'recordAi.historical')}
        </H>
        {version.stage && version.stage !== 'final' && (
          <Text variant="note">{t('recordAi.provisional')}</Text>
        )}
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
        {version.asr_status && version.asr_status !== 'unverified' && (
          <Text variant="note">{t(`recordAi.asr.${version.asr_status}`)}</Text>
        )}
        <Text>{version.content.overview}</Text>
        {(
          ['decisions', 'chapters', 'action_items', 'open_questions'] as const
        ).map(
          (kind) =>
            version.content[kind].length > 0 && (
              <section key={kind}>
                <h4>{t(`recordAi.sections.${kind}`)}</h4>
                <ul>
                  {version.content[kind].map((point, index) => (
                    <li
                      key={index}
                      className={css({ marginBottom: '0.75rem' })}
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
              </section>
            )
        )}
      </div>
    </article>
  )
}
