import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { css } from '@/styled-system/css'

interface Preview {
  job_id: string
  status: string
  last_sequence: number
  published: boolean
  next_after_sequence: number | null
  results: Array<{
    id: string
    sequence: number
    start_ms: number
    end_ms: number | null
    text: string
    language: string
  }>
}

export function LiveCaptureTranscript({
  viewerId,
  captureId,
  jobId,
  lastSequence,
}: {
  viewerId: string
  captureId: string
  jobId: string
  lastSequence: number
}) {
  const { t } = useTranslation('capture')
  const [older, setOlder] = useState<number>()
  const after = older ?? Math.max(0, lastSequence - 50)
  const path = `capture-sessions/${captureId}/transcription/${jobId}/preview/?after_sequence=${after}`
  const query = useQuery({
    queryKey: ['capture-live-preview', viewerId, path],
    queryFn: ({ signal }) =>
      fetchApi<Preview>(path, { signal, cache: 'no-store' }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) => (query.state.error ? false : 3000),
  })
  if (query.isError || (query.data && query.data.job_id !== jobId))
    return (
      <StateHint
        state="error"
        action={
          <Button variant="secondary" onPress={() => void query.refetch()}>
            {t('asr.refreshText')}
          </Button>
        }
      >
        {t('asr.textError')}
      </StateHint>
    )
  if (!query.data)
    return <StateHint state="loading">{t('asr.loading')}</StateHint>
  return (
    <section
      aria-label={t('asr.liveText')}
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'md',
        minWidth: 0,
      })}
    >
      <h3>{t('asr.liveText')}</h3>
      <p>{t('asr.previewHint')}</p>
      {['incomplete', 'canceled'].includes(query.data.status) && (
        <p role="status">{t('asr.partialPreview')}</p>
      )}
      {!query.data.results.length && (
        <p role="status">{t('asr.waitingText')}</p>
      )}
      {query.data.results.map((row) => (
        <article
          key={row.id}
          className={css({
            borderBottomWidth: '1px',
            borderColor: 'border.default',
            paddingY: 'sm',
          })}
        >
          {/* `fontSize: 'sm'` 不是本仓库的字号 token(Panda 只挂了 10–64 的数字档),
              这条声明此前一直静默失效 —— 改成 Material 语义字阶。 */}
          <p
            className={css({ textStyle: 'bodySmall', color: 'text.secondary' })}
          >
            {Math.floor(row.start_ms / 60000)}:
            {String(Math.floor(row.start_ms / 1000) % 60).padStart(2, '0')}
          </p>
          <p
            className={css({
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            })}
          >
            {row.text}
          </p>
        </article>
      ))}
      <div className={css({ display: 'flex', gap: 'md', flexWrap: 'wrap' })}>
        {after > 0 && (
          <Button
            variant="secondary"
            onPress={() => setOlder(Math.max(0, after - 50))}
          >
            {t('previous')}
          </Button>
        )}
        {query.data.next_after_sequence !== null && (
          <Button
            variant="secondary"
            onPress={() => setOlder(query.data!.next_after_sequence!)}
          >
            {t('next')}
          </Button>
        )}
        {older !== undefined && (
          <Button variant="secondary" onPress={() => setOlder(undefined)}>
            {t('asr.followLatest')}
          </Button>
        )}
      </div>
    </section>
  )
}
