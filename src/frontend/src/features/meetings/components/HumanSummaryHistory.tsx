import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import type {
  ApiRecordSummaryVersion,
  RecordSourceReference,
} from '../api/ApiMeetingRecord'

type Header = { id: string; revision: number; created_at: string }
const stack = css({ display: 'flex', flexDirection: 'column', gap: '0.75rem' })
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
  const detail = useQuery({
    queryKey: ['human-summary-history-detail', viewerId, path, selected],
    queryFn: ({ signal }) =>
      fetchApi<
        Header & {
          content: ApiRecordSummaryVersion['content']
          input_snapshot_id: string
        }
      >(`${path}${encodeURIComponent(selected!)}/`, { signal }),
    enabled: opened && !!selected,
    gcTime: 0,
    retry: false,
    staleTime: 0,
  })
  const value = detail.isError ? undefined : detail.data
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
          {detail.isError && <Text>{t('humanReview.unavailable')}</Text>}
          {!query.isError && selected && value && (
            <article className={stack}>
              <h4>
                {t('humanReview.historyVersion', { revision: value.revision })}
              </h4>
              <Text variant="note">{t('humanReview.historyReadOnly')}</Text>
              <Text>{value.content.overview}</Text>
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
                      {onSource &&
                        point.source_refs.map((ref, i) => (
                          <Button
                            size="sm"
                            variant="tertiary"
                            key={i}
                            onPress={() =>
                              onSource(value.input_snapshot_id, ref)
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
          )}
        </>
      )}
    </section>
  )
}
