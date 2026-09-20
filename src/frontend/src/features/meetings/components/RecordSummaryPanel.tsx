import { useSearch } from 'wouter'
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
import { receiptRole } from './liveRegionRole'

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
  gap: 'lg',
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
  chaptersOnly = false,
}: {
  recordId: string
  viewerId: string
  onSourceAudio?: (milliseconds: number) => void
  showHeading?: boolean
  selectedVersionId?: string
  duringCapture?: boolean
  chaptersOnly?: boolean
}) => {
  const { t } = useTranslation('meetings')
  const detail = useMeetingRecord(viewerId, recordId, true)
  const allowed = !!detail.data?.capabilities.read_summary && !detail.isError
  const progress = useRecordSummaryJob(
    viewerId,
    recordId,
    allowed && !chaptersOnly
  )
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
  const search = useSearch()
  const [tool, setTool] = useState<string | undefined>(() =>
    new URLSearchParams(search).get('review') === 'true' ? 'edit' : undefined
  )
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

  if (detail.isError || (!chaptersOnly && progress.isError))
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
  if (
    !detail.data ||
    (allowed && ((!chaptersOnly && !progress.data) || !versions.data))
  )
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
      {!chaptersOnly && (
        <>
          {!duringCapture && (
            <div
              role="group"
              aria-label={t('minutesReader.tools')}
              className={css({
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'sm',
                paddingBottom: 'md',
                borderBottom: '1px solid token(colors.border.subtle)',
              })}
            >
              {(['ask', 'edit', 'share', 'notify', 'manage'] as const)
                .filter(
                  (value) =>
                    (value !== 'ask' ||
                      detail.data.capabilities.read_transcript) &&
                    (!pinned || !['edit', 'manage'].includes(value))
                )
                .map((value) => (
                  // 选中态必须看得见:`buttonRecipe` 没有 `[aria-pressed]` 样式,
                  // 原先五颗都用 `tertiary`(= action.selected.bg) → 选中的那颗和
                  // 其余四颗长得一模一样,用户不知道当前打开的是哪个面板。
                  // 现在选中走 `tertiary`(品牌浅蓝容器),未选中走 `secondaryText`。
                  <Button
                    key={value}
                    size="sm"
                    variant={tool === value ? 'tertiary' : 'secondaryText'}
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
              <SummaryAutomationControl
                recordId={recordId}
                viewerId={viewerId}
              />
            )}
            {!pinned && job && (
              // 生成中:进度区声明 aria-busy,读屏才知道这里在持续更新
              // (§3「loading 同时设置 aria-busy」)。
              <div role="status" aria-busy={busy || undefined}>
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
                  gap: 'sm',
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
                          isDisabled={
                            busy || mutation.isPending || !recovery.ready
                          }
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
                          !ready ||
                          busy ||
                          mutation.isPending ||
                          !recovery.ready
                        }
                        onPress={() =>
                          void submit(job ? 'regenerate' : 'generate')
                        }
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
            {/* `message` 既可能是「已接受」也可能是一条错误
                (限流 / 权限 / 结果不确定),两类必须用不同的 live region:
                成功用 polite 的 status,失败用 assertive 的 alert。 */}
            {message && <div role={receiptRole(message)}>{t(message)}</div>}
            {!pinned && canGenerate && recovery.failed && (
              <div role="alert">
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
                  time: new Date(
                    progress.data.next_update_at
                  ).toLocaleTimeString(),
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
        </>
      )}
      {versions.data?.results.length === 0 && (
        <StateHint>
          {t(chaptersOnly ? 'chapterReader.noVersion' : 'recordAi.noVersions')}
        </StateHint>
      )}
      {primaryVersion && (
        <Version
          chaptersOnly={chaptersOnly}
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
            paddingTop: 'lg',
            borderTop: '1px solid token(colors.border.subtle)',
          })}
        >
          <summary
            className={css({
              cursor: 'pointer',
              textStyle: 'titleSmall',
              fontWeight: 'semibold',
              paddingBottom: 'lg',
            })}
          >
            {t('minutesReader.history')}
          </summary>
          {otherVersions.map((version) => (
            <Version
              chaptersOnly={chaptersOnly}
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
            ...(!chaptersOnly ? [progress.refetch()] : []),
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
  chaptersOnly = false,
}: {
  version: ApiRecordSummaryVersion
  recordId: string
  viewerId: string
  onSource?: (ref: RecordSourceReference) => void
  duringCapture?: boolean
  chaptersOnly?: boolean
}) => {
  const { t } = useTranslation('meetings')
  return (
    <article
      className={css({
        padding: 'sm 0',
        '& p': { lineHeight: 1.85, overflowWrap: 'anywhere' },
      })}
    >
      <div className={stack}>
        <p className={css({ textStyle: 'bodySmall', color: 'text.secondary' })}>
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
              textStyle: 'bodySmall',
              color: 'text.secondary',
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
        {!chaptersOnly && (
          <section
            className={css({
              padding: '1.25rem',
              borderRadius: 'panel',
              backgroundColor: 'surface.canvas',
            })}
          >
            <h3
              className={css({
                textStyle: 'titleLarge',
                marginBottom: 'md',
              })}
            >
              {t('minutesReader.overview')}
            </h3>
            <Text>{version.content.overview}</Text>
          </section>
        )}
        {chaptersOnly && (
          <Text variant="note">{t('chapterReader.aiVersion')}</Text>
        )}
        {version.content.chapters.length === 0 && (
          <Text variant="note">{t('chapterReader.empty')}</Text>
        )}
        {(chaptersOnly
          ? (['chapters'] as const)
          : ([
              'decisions',
              'action_items',
              'chapters',
              'open_questions',
            ] as const)
        ).map(
          (kind) =>
            version.content[kind].length > 0 && (
              <details key={kind} open className={css({ padding: 'md 0' })}>
                <summary
                  className={css({
                    cursor: 'pointer',
                    textStyle: 'titleMedium',
                    marginBottom: 'lg',
                  })}
                >
                  {t(`recordAi.sections.${kind}`)}{' '}
                  <span
                    className={css({
                      textStyle: 'bodyMedium',
                      color: 'text.secondary',
                      marginLeft: 'sm',
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
                        marginBottom: 'lg',
                        padding: 'xs 0 xs lg',
                        borderLeft: '2px solid token(colors.brand.200)',
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
        {!chaptersOnly && !duringCapture && (
          <details>
            <summary
              className={css({
                cursor: 'pointer',
                color: 'text.link',
                padding: 'md 0',
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
