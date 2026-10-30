import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'wouter'
import {
  RiArrowLeftLine,
  RiCheckLine,
  RiCloseLine,
  RiEditLine,
  RiRefreshLine,
  RiStopCircleLine,
} from '@remixicon/react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/primitives/Button'
import { Input } from '@/primitives/Input'
import { PageState } from '@/components/PageState'
import { TextArea } from '@/primitives/TextArea'
import { css, cx } from '@/styled-system/css'
import {
  useAcceptWorkTask,
  useCancelWorkRun,
  useUpdateWorkTitle,
  useWorkTask,
  workQueryKeys,
} from '../api/queries'
import { fetchWorkTask } from '../api/client'
import { useIdempotencyKey } from '../hooks/useIdempotencyKey'
import { useReadOnlyViewport } from '../hooks/useReadOnlyViewport'
import { useTaskEventStream } from '../hooks/useTaskEventStream'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { TaskStatusBadge } from '../components/TaskStatusBadge'
import {
  card,
  errorText,
  label,
  muted,
  notice,
  page,
  row,
  sectionTitle,
} from '../ui'

const terminalStates = new Set(['completed', 'canceled', 'archived'])

export const TaskWorkspacePage = () => {
  const { t } = useTranslation('work')
  const { taskId } = useParams<{ taskId: string }>()
  const taskQ = useWorkTask(taskId)
  const queryClient = useQueryClient()
  const cancelMutation = useCancelWorkRun(taskId ?? '')
  const acceptMutation = useAcceptWorkTask(taskId ?? '')
  const updateMutation = useUpdateWorkTitle(taskId ?? '')
  const titleKey = useIdempotencyKey()
  const acceptKey = useIdempotencyKey()
  const readOnly = useReadOnlyViewport()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleError, setTitleError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)
  const lastEventIdRef = useRef<string | null>(null)

  const detail = taskQ.data
  const taskState = detail?.summary.task_state ?? ''
  const sseEnabled =
    !!taskId &&
    !!detail &&
    !terminalStates.has(taskState) &&
    taskState !== 'awaiting_acceptance'
  const stream = useTaskEventStream(
    taskId,
    sseEnabled,
    async () => {
      const queryKey = workQueryKeys.task(taskId!)
      // Do not reuse an in-flight fetch that began before the resync boundary.
      await queryClient.cancelQueries({ queryKey, exact: true })
      const fresh = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => fetchWorkTask(taskId!),
        staleTime: 0,
        retry: false,
      })
      return fresh.latest_event_id
    },
    detail?.latest_event_id
  )

  useEffect(() => {
    const last = stream.events.at(-1)
    if (!last) {
      lastEventIdRef.current = null
      return
    }
    if (last.event_id === lastEventIdRef.current) return
    lastEventIdRef.current = last.event_id
    void queryClient.invalidateQueries({ queryKey: ['work', 'task', taskId] })
    void queryClient.invalidateQueries({ queryKey: ['work', 'tasks'] })
  }, [stream.events, queryClient, taskId])

  useEffect(() => {
    if (readOnly) setEditingTitle(false)
  }, [readOnly])

  const artifact = detail?.summary.latest_artifact
  const run = detail?.summary.latest_run
  const canCancel = !!run && ['queued', 'active', 'waiting'].includes(run.state)
  const canAccept = detail?.summary.task_state === 'awaiting_acceptance'

  const timeline = useMemo(() => {
    if (!detail) return []
    const synthetic = {
      key: `created-${detail.summary.task_id}`,
      time: detail.summary.created_at,
      type: 'task.submitted',
      seq: 0,
      payload: { state: detail.summary.task_state },
    }
    return [
      synthetic,
      ...stream.events.map((event) => ({
        key: event.event_id,
        time: event.occurred_at,
        type: event.type,
        seq: event.seq,
        payload: event.payload,
      })),
    ]
  }, [detail, stream.events])

  if (taskQ.isLoading) {
    return (
      <div className={page}>
        <p className={muted}>{t('loading')}</p>
      </div>
    )
  }
  if (taskQ.isError || !detail) {
    return (
      <div className={page}>
        <PageState
          state="error"
          icon={<RiRefreshLine size={20} aria-hidden="true" />}
          title={t('task.loadErrorTitle')}
          description={t('task.loadErrorDescription')}
          action={
            <div className={row}>
              <Link href="/work/items?view=all">
                <Button variant="secondary" size="dense">
                  {t('task.back')}
                </Button>
              </Link>
              {readOnly ? null : (
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={() => taskQ.refetch()}
                >
                  {t('retry')}
                </Button>
              )}
            </div>
          }
        />
      </div>
    )
  }

  const startEditing = () => {
    setTitleDraft(detail.summary.title)
    setTitleError(null)
    setEditingTitle(true)
  }

  const saveTitle = async () => {
    const value = titleDraft.trim()
    if (!value) {
      setTitleError(t('task.titleEmpty'))
      return
    }
    try {
      await updateMutation.mutateAsync({
        client_request_id: titleKey.key,
        expected_revision: detail.summary.revision,
        title: value,
      })
      setEditingTitle(false)
      titleKey.rotate()
    } catch (cause) {
      setTitleError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onCancel = async () => {
    if (!run) return
    setActionError(null)
    try {
      await cancelMutation.mutateAsync(run.id)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onAccept = async () => {
    setActionError(null)
    try {
      if (artifact) {
        await acceptMutation.mutateAsync({
          client_request_id: acceptKey.key,
          expected_revision: detail.summary.revision,
          artifact_id: artifact.artifact_id,
          version_no: artifact.version_no,
        })
      } else {
        const value = reason.trim()
        if (!value) {
          setActionError(t('task.acceptReasonRequired'))
          return
        }
        await acceptMutation.mutateAsync({
          client_request_id: acceptKey.key,
          expected_revision: detail.summary.revision,
          completion_reason: value,
        })
      }
      setAccepted(true)
      acceptKey.rotate()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={page}>
      <div
        className={css({ display: 'flex', flexDirection: 'column', gap: 'sm' })}
      >
        <Link
          href="/work/items?view=all"
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'xxs',
            color: 'text.secondary',
            textDecoration: 'none',
            textStyle: 'bodyMedium',
            alignSelf: 'flex-start',
          })}
        >
          <RiArrowLeftLine size={14} aria-hidden="true" />
          {t('task.back')}
        </Link>
        {readOnly ? (
          <p className={notice} role="status">
            {t('readOnly.taskNotice')}
          </p>
        ) : null}
        <div
          className={css({
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'sm',
            flexWrap: 'wrap',
          })}
        >
          <div
            className={css({
              flex: 1,
              minWidth: '16rem',
              display: 'flex',
              flexDirection: 'column',
              gap: 'xs',
            })}
          >
            {!readOnly && editingTitle ? (
              <div
                className={css({
                  display: 'flex',
                  gap: 'xxs',
                  alignItems: 'center',
                })}
              >
                <Input
                  aria-label={t('task.titleLabel')}
                  value={titleDraft}
                  maxLength={80}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveTitle()
                    if (event.key === 'Escape') setEditingTitle(false)
                  }}
                />
                <Button
                  size="icon28"
                  variant="quaternaryText"
                  aria-label={t('task.saveTitle')}
                  loading={updateMutation.isPending}
                  onPress={() => void saveTitle()}
                >
                  <RiCheckLine size={16} aria-hidden="true" />
                </Button>
                <Button
                  size="icon28"
                  variant="quaternaryText"
                  aria-label={t('task.cancelEdit')}
                  onPress={() => setEditingTitle(false)}
                >
                  <RiCloseLine size={16} aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'xs',
                })}
              >
                <h1 className={css({ margin: 0, textStyle: 'titleLarge' })}>
                  {detail.summary.title}
                </h1>
                {readOnly ? null : (
                  <Button
                    size="icon28"
                    variant="quaternaryText"
                    aria-label={t('task.editTitle')}
                    onPress={startEditing}
                  >
                    <RiEditLine size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
            )}
            <div className={row}>
              <TaskStatusBadge state={detail.summary.display_state} />
              <span className={muted}>
                {t('task.revision', { revision: detail.summary.revision })}
              </span>
              {run ? (
                <span className={muted}>
                  {t('task.attempt', { attempt: run.attempt_no })}
                </span>
              ) : null}
            </div>
            {!readOnly && titleError ? (
              <p className={errorText}>{titleError}</p>
            ) : null}
          </div>
          <div className={row}>
            {!readOnly && canCancel ? (
              <Button
                variant="secondary"
                size="dense"
                loading={cancelMutation.isPending}
                icon={<RiStopCircleLine size={16} aria-hidden="true" />}
                onPress={() => void onCancel()}
              >
                {t('task.cancelRun')}
              </Button>
            ) : null}
          </div>
        </div>
        {!readOnly && actionError ? (
          <p className={errorText}>{actionError}</p>
        ) : null}
      </div>

      <div
        className={css({
          display: 'grid',
          gap: 'lg',
          gridTemplateColumns: {
            base: '1fr',
            lg: 'minmax(0, 1.4fr) minmax(18rem, 0.6fr)',
          },
        })}
      >
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'lg',
            minWidth: 0,
          })}
        >
          <section className={card}>
            <h2 className={sectionTitle}>{t('task.goal')}</h2>
            <p className={css({ whiteSpace: 'pre-wrap', marginTop: 'sm' })}>
              {detail.goal}
            </p>
            {detail.background ? (
              <>
                <h3 className={cx(label, css({ marginTop: 'md' }))}>
                  {t('task.background')}
                </h3>
                <p className={css({ whiteSpace: 'pre-wrap' })}>
                  {detail.background}
                </p>
              </>
            ) : null}
          </section>

          <section className={card}>
            <div
              className={css({
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'sm',
                alignItems: 'center',
              })}
            >
              <h2 className={sectionTitle}>{t('task.timeline')}</h2>
              <span className={muted}>
                {streamLabel(stream.status, (key) => t(key))}
              </span>
            </div>
            <ol
              className={css({
                listStyle: 'none',
                margin: 0,
                padding: 0,
                marginTop: 'sm',
              })}
            >
              {timeline.map((event) => (
                <li
                  key={event.key}
                  className={css({
                    paddingY: 'sm',
                    borderTop: '1px solid token(colors.border.subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'xxs',
                  })}
                >
                  <div
                    className={css({
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'sm',
                    })}
                  >
                    <strong>
                      {t(`event.${event.type}`, { defaultValue: event.type })}
                    </strong>
                    <span className={muted}>
                      {new Date(event.time).toLocaleString()}
                    </span>
                  </div>
                  <span className={muted}>
                    {t('task.seq', { seq: event.seq })}
                  </span>
                  {event.payload?.state ? (
                    <span className={muted}>
                      {t('task.eventState', {
                        state: String(event.payload.state),
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
            {stream.events.length === 0 ? (
              <p className={muted}>{t('task.noLiveEvents')}</p>
            ) : null}
          </section>
        </div>

        <aside
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'lg',
            minWidth: 0,
          })}
        >
          <section className={card}>
            <h2 className={sectionTitle}>{t('task.run')}</h2>
            {run ? (
              <dl
                className={css({
                  display: 'grid',
                  gridTemplateColumns: 'max-content 1fr',
                  gap: 'xxs md',
                  marginTop: 'sm',
                })}
              >
                <dt className={label}>{t('task.runState')}</dt>
                <dd className={css({ margin: 0 })}>
                  {t(`run.${run.state}`, { defaultValue: run.state })}
                </dd>
                <dt className={label}>{t('task.runtime')}</dt>
                <dd className={css({ margin: 0 })}>{run.runtime_version}</dd>
                {run.wait_reason ? (
                  <>
                    <dt className={label}>{t('task.waitReason')}</dt>
                    <dd className={css({ margin: 0 })}>{run.wait_reason}</dd>
                  </>
                ) : null}
                {run.terminal_reason ? (
                  <>
                    <dt className={label}>{t('task.terminalReason')}</dt>
                    <dd className={css({ margin: 0 })}>
                      {run.terminal_reason}
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className={muted}>{t('task.noRun')}</p>
            )}
            <h3 className={cx(label, css({ marginTop: 'md' }))}>
              {t('task.quota')}
            </h3>
            <p className={muted}>
              {t('task.quotaDetail', {
                reserved: detail.summary.quota.reserved_tokens,
                settled: detail.summary.quota.settled_tokens,
              })}
            </p>
          </section>

          <section className={card}>
            <h2 className={sectionTitle}>{t('task.snapshot')}</h2>
            <dl
              className={css({
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                gap: 'xxs md',
                marginTop: 'sm',
              })}
            >
              <dt className={label}>{t('task.template')}</dt>
              <dd className={css({ margin: 0 })}>
                {detail.template
                  ? `${detail.template.name} v${detail.template.version}`
                  : detail.snapshot
                    ? t('task.templateMissing')
                    : '—'}
              </dd>
              <dt className={label}>{t('task.snapshotRevision')}</dt>
              <dd className={css({ margin: 0 })}>
                {detail.snapshot
                  ? `v${detail.snapshot.snapshot_revision}`
                  : '—'}
              </dd>
              <dt className={label}>{t('task.permissionMode')}</dt>
              <dd className={css({ margin: 0 })}>
                {detail.snapshot
                  ? t(`composer.mode.${detail.snapshot.permission_mode}`, {
                      defaultValue: detail.snapshot.permission_mode,
                    })
                  : '—'}
              </dd>
            </dl>
          </section>

          {!readOnly && (canAccept || accepted) ? (
            <section className={card}>
              <h2 className={sectionTitle}>{t('task.acceptTitle')}</h2>
              {accepted ? null : (
                <p className={muted}>
                  {artifact
                    ? t('task.acceptArtifactHint')
                    : t('task.acceptHint')}
                </p>
              )}
              {accepted ? (
                <p
                  className={css({
                    color: 'status.success.container-text',
                    marginTop: 'sm',
                  })}
                >
                  {t('task.accepted')}
                </p>
              ) : artifact ? (
                <Button
                  size="dense"
                  loading={acceptMutation.isPending}
                  onPress={() => void onAccept()}
                  className={css({ marginTop: 'sm' })}
                >
                  {t('task.confirmAcceptArtifact')}
                </Button>
              ) : (
                <>
                  <TextArea
                    aria-label={t('task.acceptReason')}
                    value={reason}
                    rows={3}
                    maxLength={500}
                    placeholder={t('task.acceptPlaceholder')}
                    onChange={(event) => setReason(event.target.value)}
                    className={css({ marginTop: 'sm' })}
                  />
                  <Button
                    size="dense"
                    loading={acceptMutation.isPending}
                    isDisabled={!reason.trim()}
                    onPress={() => void onAccept()}
                    className={css({ marginTop: 'sm' })}
                  >
                    {t('task.confirmAccept')}
                  </Button>
                </>
              )}
            </section>
          ) : null}

          {detail.summary.latest_artifact ? (
            <ArtifactPanel
              artifactId={detail.summary.latest_artifact.artifact_id}
              versionNo={detail.summary.latest_artifact.version_no}
              contentHash={detail.summary.latest_artifact.content_hash}
              readOnly={readOnly}
            />
          ) : null}
        </aside>
      </div>
    </div>
  )
}

const streamLabel = (status: string, t: (key: string) => string) => {
  if (status === 'open') return t('task.streamOpen')
  if (status === 'connecting') return t('task.streamConnecting')
  if (status === 'reconnecting') return t('task.streamReconnecting')
  if (status === 'error') return t('task.streamError')
  return ''
}
