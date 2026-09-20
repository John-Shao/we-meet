import { useState, type ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { useRecordTranscriptVersion } from '../api/fetchMeetingRecord'
import { Link } from 'wouter'
import { SummaryExportControl } from './SummaryExportControl'
import type {
  ApiRecordSummaryVersion,
  RecordSourceReference,
} from '../api/ApiMeetingRecord'

type Header = { id: string; revision: number; created_at: string }
const stack = css({ display: 'flex', flexDirection: 'column', gap: 'md' })
export const HumanSummaryHistory = ({
  recordId,
  viewerId,
  currentId,
  onSource,
}: {
  recordId: string
  viewerId: string
  currentId: string
  onSource?: (snapshotId: string, ref: RecordSourceReference) => void
}) => {
  const { t } = useTranslation('meetings')
  const [opened, setOpened] = useState(false)
  const [before, setBefore] = useState<number>()
  const [selected, setSelected] = useState<string>()
  const path = `meeting-records/${encodeURIComponent(recordId)}/human-summary/history/`
  const query = useQuery({
    queryKey: ['human-summary-history', viewerId, path, currentId, before],
    queryFn: ({ signal }) =>
      fetchApi<{ results: Header[]; next_before: number | null }>(
        `${path}${before ? `?before=${before}` : ''}`,
        { signal }
      ),
    enabled: opened,
    gcTime: 0,
    retry: false,
    staleTime: 0,
  })
  return (
    <section className={stack}>
      <Button
        size="sm"
        variant="tertiary"
        onPress={() => {
          setOpened(!opened)
          setSelected(undefined)
        }}
      >
        {t(opened ? 'humanReview.closeHistory' : 'humanReview.history')}
      </Button>
      {opened && (
        <>
          {query.isError ? (
            <Text>{t('humanReview.unavailable')}</Text>
          ) : (
            <>
              {query.data?.results.map((row) => (
                <Button
                  size="sm"
                  variant="tertiary"
                  key={row.id}
                  onPress={() => setSelected(row.id)}
                >
                  {t('humanReview.historyVersion', { revision: row.revision })}{' '}
                  · {new Date(row.created_at).toLocaleString()}
                </Button>
              ))}
              {query.data?.next_before && (
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() => {
                    setBefore(query.data!.next_before!)
                    setSelected(undefined)
                  }}
                >
                  {t('recordAi.older')}
                </Button>
              )}
              {before && (
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() => {
                    setBefore(undefined)
                    setSelected(undefined)
                  }}
                >
                  {t('recordAi.latest')}
                </Button>
              )}
            </>
          )}
          {!query.isError && selected && (
            <HumanSummaryRevision
              key={`${viewerId}:${recordId}:${selected}`}
              recordId={recordId}
              viewerId={viewerId}
              versionId={selected}
              onSource={onSource}
            />
          )}
        </>
      )}
    </section>
  )
}

/** Exact immutable review; no latest-review or AI fallback. */
export const HumanSummaryRevision = (
  props: ComponentProps<typeof HumanSummaryRevisionContent>
) => (
  <HumanSummaryRevisionContent
    key={JSON.stringify([props.viewerId, props.recordId, props.versionId])}
    {...props}
  />
)

function HumanSummaryRevisionContent({
  recordId,
  viewerId,
  versionId,
  onSource,
  canReadTranscript = false,
  onSourceAudio,
  linked = false,
}: {
  recordId: string
  viewerId: string
  versionId: string
  onSource?: (snapshotId: string, ref: RecordSourceReference) => void
  canReadTranscript?: boolean
  onSourceAudio?: (ms: number) => void
  linked?: boolean
}) {
  const { t } = useTranslation('meetings')
  const path = `meeting-records/${encodeURIComponent(recordId)}/human-summary/history/`
  const [citation, setCitation] = useState<{
    snapshotId: string
    ref: RecordSourceReference
  }>()
  const detail = useQuery({
    queryKey: ['human-summary-history-detail', viewerId, path, versionId],
    queryFn: ({ signal }) =>
      fetchApi<
        Header & {
          content: ApiRecordSummaryVersion['content']
          input_snapshot_id: string
        }
      >(`${path}${encodeURIComponent(versionId!)}/`, { signal }),
    enabled: !!versionId,
    gcTime: 0,
    retry: false,
    staleTime: 0,
    refetchInterval: (q) => (q.state.error ? false : 15000),
  })
  const value =
    detail.isError || detail.data?.id !== versionId ? undefined : detail.data

  const original = useRecordTranscriptVersion(
    viewerId,
    recordId,
    citation?.snapshotId,
    canReadTranscript && !!value
  )
  const source = original.data?.segments.find(
    (segment) =>
      citation &&
      segment.segment_id === citation.ref.segment_id &&
      segment.segment_revision === citation.ref.segment_revision &&
      segment.start_ms === citation.ref.start_ms &&
      segment.end_ms === citation.ref.end_ms
  )
  return (
    <section className={stack}>
      {linked && (
        <Link
          href={`/meeting/records/${encodeURIComponent(recordId)}?tab=summary`}
        >
          {t('summaryNotice.allVersions')}
        </Link>
      )}
      {detail.isError || !versionId || (detail.data && !value) ? (
        <Text>{t('humanReview.unavailable')}</Text>
      ) : !value ? (
        <Text>{t('loading')}</Text>
      ) : (
        <>
          <article className={stack}>
            <h4>
              {t('humanReview.historyVersion', { revision: value.revision })}
            </h4>
            <Text variant="note">{t('humanReview.historyReadOnly')}</Text>
            <Text>{value.content.overview}</Text>
            <SummaryExportControl
              recordId={recordId}
              viewerId={viewerId}
              sourceId={value.id}
              sourceKind="human"
            />
            {(
              [
                'decisions',
                'chapters',
                'action_items',
                'open_questions',
              ] as const
            ).map((kind) => (
              <section key={kind}>
                <h5>{t(`recordAi.sections.${kind}`)}</h5>
                {value.content[kind].map((point, index) => (
                  <div key={index} className={stack}>
                    <Text>{point.text}</Text>
                    {'owner_text' in point && (
                      <Text variant="note">
                        {[point.owner_text, point.due_text]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    )}
                    {point.source_refs.length === 0 && (
                      <Text variant="note">{t('humanReview.uncited')}</Text>
                    )}
                    {(onSource || canReadTranscript) &&
                      point.source_refs.map((ref, i) => (
                        <Button
                          size="sm"
                          variant="tertiary"
                          key={i}
                          onPress={() =>
                            onSource
                              ? onSource(value.input_snapshot_id, ref)
                              : setCitation({
                                  snapshotId: value.input_snapshot_id,
                                  ref,
                                })
                          }
                        >
                          {t('recordAi.source')}{' '}
                          {Math.floor(ref.start_ms / 1000)}s
                        </Button>
                      ))}
                  </div>
                ))}
              </section>
            ))}
          </article>
          {canReadTranscript && citation && (
            <section aria-label={t('recordAi.source')} className={stack}>
              <h4>{t('recordAi.source')}</h4>
              <Text>
                {original.isError
                  ? t('recordAi.unavailable')
                  : original.isLoading
                    ? t('loading')
                    : (source?.text ?? t('recordAi.sourceMissing'))}
              </Text>
              {onSourceAudio &&
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
        </>
      )}
    </section>
  )
}
