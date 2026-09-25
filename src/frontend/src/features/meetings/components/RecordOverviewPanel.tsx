import { RecordPanelTools } from './RecordPanel'
import { useTranslation } from 'react-i18next'
import { useRef, useState } from 'react'
import { Link } from 'wouter'
import {
  RiFileTextLine,
  RiRefreshLine,
  RiSparklingLine,
} from '@remixicon/react'
import { StateHint } from '@/components/StateHint'
import { Button, LinkButton, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { ApiError } from '@/api/ApiError'
import { useRecordOverview, useRequestOverview } from '../api/recordOverview'
import { isSummaryPayload, useSummaryIntent } from '../hooks/useSummaryIntent'
import type { SummaryRequestPayload } from '../api/ApiMeetingRecord'
import { formatDateTime } from '../recordDateTime'

/** Independent original-text generation; never reads a minutes version. */
export function RecordOverviewPanel({
  viewerId,
  recordId,
  onSourceAudio,
  chaptersOnly = false,
}: {
  viewerId: string
  recordId: string
  onSourceAudio?: (milliseconds: number) => void
  chaptersOnly?: boolean
}) {
  const { t } = useTranslation('meetings')
  const query = useRecordOverview(viewerId, recordId)
  const mutation = useRequestOverview(viewerId, recordId)
  const recovery = useSummaryIntent(
    'overview',
    viewerId,
    recordId,
    isSummaryPayload
  )
  const inFlight = useRef(false)
  const [message, setMessage] = useState('')
  const state = query.isError ? undefined : query.data
  const version = state?.version
  const job = state?.job
  const busy = ['queued', 'running'].includes(job?.status ?? '')
  const submit = async (operation: SummaryRequestPayload['operation']) => {
    if (!state?.can_generate || inFlight.current || !recovery.ready) return
    inFlight.current = true
    setMessage('')
    let intent: ReturnType<typeof recovery.getOrCreate>
    try {
      intent = recovery.getOrCreate({
        operation,
        expected_revision: state.revision,
        expected_job_id: job?.id ?? null,
        expected_attempt: job?.attempt ?? null,
      })
    } catch {
      inFlight.current = false
      return
    }
    try {
      await mutation.mutateAsync(intent)
      if (recovery.resolve(intent)) setMessage('accepted')
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 409, 422].includes(error.statusCode)
      ) {
        recovery.resolve(intent)
        setMessage('conflict')
      } else if (error instanceof ApiError && error.statusCode === 429)
        setMessage('rateLimited')
      else setMessage('uncertain')
      await query.refetch()
    } finally {
      inFlight.current = false
    }
  }
  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'lg' })}
    >
      <RecordPanelTools>
        {state?.can_generate && (
          <>
            {recovery.pending ? (
              <Button
                size="sm"
                variant="secondaryText"
                icon={<RiRefreshLine size={16} aria-hidden />}
                isDisabled={!recovery.ready || mutation.isPending}
                onPress={() => void submit(recovery.pending!.payload.operation)}
              >
                {t('recordOverview.resubmit')}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondaryText"
                  icon={
                    job ? (
                      <RiRefreshLine size={16} aria-hidden />
                    ) : (
                      <RiSparklingLine size={16} aria-hidden />
                    )
                  }
                  isDisabled={
                    !state.generation_ready ||
                    busy ||
                    mutation.isPending ||
                    !recovery.ready
                  }
                  onPress={() => void submit(job ? 'regenerate' : 'generate')}
                >
                  {t(
                    job
                      ? 'recordOverview.regenerate'
                      : 'recordOverview.generate'
                  )}
                </Button>
                {job?.retryable && !busy && (
                  <Button
                    size="sm"
                    variant="secondaryText"
                    icon={<RiRefreshLine size={16} aria-hidden />}
                    isDisabled={mutation.isPending || !recovery.ready}
                    onPress={() => void submit('retry')}
                  >
                    {t('recordOverview.retry')}
                  </Button>
                )}
              </>
            )}
          </>
        )}
        <Link href={`/meeting/records/${recordId}?tab=summary`} asChild>
          <LinkButton size="sm" variant="secondaryText">
            <RiFileTextLine size={16} aria-hidden />
            {t('recordOverview.openMinutes')}
          </LinkButton>
        </Link>
      </RecordPanelTools>
      <Text variant="note">{t('recordOverview.hint')}</Text>
      {state?.can_generate && (
        <div>
          {!state.generation_ready && (
            <Text variant="note">{t('recordOverview.waitSource')}</Text>
          )}
          {recovery.failed && (
            <div role="alert">
              <Text>{t('recordOverview.storageError')}</Text>
              <Button onPress={recovery.reload}>{t('library.refresh')}</Button>
            </div>
          )}
        </div>
      )}
      {state && busy && (
        <div role="status" aria-busy="true">
          {t('recordOverview.generating')}
          {job?.chunk_progress &&
            ` ${job.chunk_progress.completed}/${job.chunk_progress.total}`}
        </div>
      )}
      {state && job && ['failed', 'canceled'].includes(job.status) && (
        <p role="alert">{t('recordOverview.failed')}</p>
      )}
      {state && message && (
        <p role={message === 'accepted' ? 'status' : 'alert'}>
          {t(`recordOverview.${message}`)}
        </p>
      )}
      {state && !state.available && (
        <Text variant="note">{t('recordOverview.unavailable')}</Text>
      )}
      {query.isError ? (
        <StateHint
          state="error"
          action={
            <Button onPress={() => void query.refetch()}>
              {t('library.refresh')}
            </Button>
          }
        >
          {t('library.loadError')}
        </StateHint>
      ) : !query.data ? (
        <StateHint state="loading">{t('loading')}</StateHint>
      ) : !version ? (
        <StateHint>{t('recordOverview.empty')}</StateHint>
      ) : (
        <article
          className={css({
            '& p': {
              lineHeight: 1.85,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            },
          })}
        >
          <Text variant="note">
            {t('minutesReader.generatedAt')}{' '}
            {formatDateTime(version.created_at)}
          </Text>
          {!version.is_current && (
            <Text variant="note">{t('recordOverview.sourceChanged')}</Text>
          )}
          {version.asr_status === 'incomplete' && (
            <Text variant="note">{t('recordAi.asr.incomplete')}</Text>
          )}
          {!chaptersOnly && <Text>{version.content.synopsis}</Text>}
          {version.content.topics.length > 0 && (
            <ul
              className={css({
                listStyleType: 'disc',
                paddingLeft: 'lg',
                '& li': {
                  marginTop: 'lg',
                  '&::marker': { color: 'text.link' },
                },
              })}
            >
              {version.content.topics.map((point, index) => (
                <li key={index}>
                  <strong>{point.title}</strong>
                  <Text>{point.text}</Text>
                  {onSourceAudio &&
                    point.source_refs.map((ref, i) => (
                      <Button
                        key={i}
                        size="sm"
                        variant="secondaryText"
                        onPress={() => onSourceAudio(ref.start_ms)}
                      >
                        {t('recordAi.listenSource')}{' '}
                        {Math.floor(ref.start_ms / 60000)}:
                        {String(Math.floor(ref.start_ms / 1000) % 60).padStart(
                          2,
                          '0'
                        )}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </article>
      )}
    </section>
  )
}
