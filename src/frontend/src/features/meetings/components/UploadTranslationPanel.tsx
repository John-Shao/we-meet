import { useRecordInfiniteQuery } from '../hooks/useRecordInfiniteQuery'
import { RecordLoadMore, RecordRefreshButton } from './RecordLoadMore'
import { useRecordViewState } from '../hooks/useRecordViewState'
import { RecordPanelTools } from './RecordPanel'
import { TranscriptExportControl } from './TranscriptExportControl'
import { selectChrome } from '@/primitives/selectChrome'
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiRefreshLine, RiTranslate2 } from '@remixicon/react'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { formatClock } from '../recordDateTime'

interface Translation {
  id: string
  record_id: string
  target: 'zh' | 'en'
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'incomplete'
    | 'canceled'
  stale: boolean
  input_revision: number
  completed_chunks: number
  total_chunks: number
}
type Intent = { key: string; target: 'zh' | 'en'; expected_revision: number }
const options = { retry: false, gcTime: 0, staleTime: 0 }
const stack = css({ display: 'flex', flexDirection: 'column', gap: 'md' })

export function UploadTranslationPanel({
  viewerId,
  recordId,
  onSource,
}: {
  viewerId: string
  recordId: string
  onSource?: (milliseconds: number) => void
}) {
  const { t } = useTranslation('meetings', { keyPrefix: 'uploadTranslation' })
  const path = `meeting-records/${recordId}/upload-translations/`
  const [target, setTarget] = useRecordViewState<'zh' | 'en'>(
    'translation-language',
    'en'
  )
  const [intent, setIntent] = useState<Intent>()
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const locked = useRef(false)
  const listing = useQuery({
    ...options,
    queryKey: ['upload-translations', viewerId, recordId, path],
    queryFn: async ({ signal }) => {
      const result = await fetchApi<{
        can_generate: boolean
        revision: number
        results: Translation[]
      }>(path, { signal, cache: 'no-store' })
      if (
        !Number.isInteger(result.revision) ||
        result.revision < 1 ||
        !Array.isArray(result.results) ||
        result.results.some((row) => row.record_id !== recordId)
      )
        throw new Error('Invalid translation identity')
      return result
    },
    refetchInterval: (q) => (q.state.error ? false : 5000),
  })
  const selected = listing.data?.results.find((item) => item.target === target)
  const active = listing.data?.results.some((item) =>
    ['queued', 'running'].includes(item.status)
  )
  const detail = useRecordInfiniteQuery({
    initialPageParam: 0,
    queryKey: [
      'upload-translation',
      viewerId,
      recordId,
      selected?.id,
      selected?.input_revision,
      path,
      target,
    ],
    enabled: !!selected && selected.status === 'succeeded' && !listing.isError,
    queryFn: async ({ signal, pageParam: page }) => {
      const result = await fetchApi<
        Translation & {
          next_page: number | null
          results: {
            segment_id: string
            text: string
            translated_text: string
            start_ms: number
            speaker_name: string
          }[]
        }
      >(`${path}${selected!.id}/?page=${page}`, { signal, cache: 'no-store' })
      if (
        result.id !== selected!.id ||
        result.record_id !== recordId ||
        result.target !== target ||
        result.input_revision !== selected!.input_revision ||
        !Array.isArray(result.results) ||
        result.results.length > 50 ||
        (result.next_page !== null && result.next_page !== page + 1)
      )
        throw new Error('Invalid translation page')
      return result
    },
  })
  const generate = async () => {
    if (locked.current || !listing.data?.can_generate) return
    const payload = intent ?? {
      key: crypto.randomUUID(),
      target,
      expected_revision: listing.data.revision,
    }
    locked.current = true
    setSaving(true)
    setIntent(payload)
    setMessage('')
    try {
      await fetchApi<Translation>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
        meetingCommand: { key: payload.key, scope: { record_id: recordId } },
      })
      setIntent(undefined)
      await listing.refetch()
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 403, 404, 409, 429].includes(error.statusCode)
      ) {
        setIntent(undefined)
        setMessage(error.statusCode === 400 ? 'budget' : 'conflict')
        await listing.refetch()
      } else setMessage('uncertain')
    } finally {
      locked.current = false
      setSaving(false)
    }
  }
  const refresh = (
    <RecordRefreshButton
      busy={listing.isFetching || detail.isFetching}
      disabled={saving || !!intent}
      onRefresh={() =>
        void Promise.allSettled([
          listing.refetch(),
          ...(selected?.status === 'succeeded' ? [detail.refetch()] : []),
        ])
      }
    />
  )
  if (listing.isError || detail.isError)
    return (
      <>
        <RecordPanelTools>{refresh}</RecordPanelTools>
        <Text role="alert">{t('unavailable')}</Text>
      </>
    )
  if (!listing.data)
    return (
      <>
        <RecordPanelTools>{refresh}</RecordPanelTools>
        <Text role="status">{t('loading')}</Text>
      </>
    )
  const stale = selected?.stale || detail.data?.stale
  return (
    <section className={stack} aria-label={t('title')}>
      <RecordPanelTools>
        {refresh}
        <label>
          <span className={css({ display: { base: 'none', sm: 'inline' } })}>
            {t('language')}{' '}
          </span>
          <select
            aria-label={t('language')}
            className={selectChrome}
            value={target}
            disabled={saving || !!intent}
            onChange={(e) => {
              setTarget(e.target.value as 'zh' | 'en')
              setMessage('')
            }}
          >
            <option value="en">{t('en')}</option>
            <option value="zh">{t('zh')}</option>
          </select>
        </label>
        {listing.data.can_generate &&
          (intent || !selected || selected.status !== 'succeeded' || stale) && (
            <Button
              size="sm"
              variant="secondaryText"
              icon={
                intent || selected ? (
                  <RiRefreshLine size={16} aria-hidden />
                ) : (
                  <RiTranslate2 size={16} aria-hidden />
                )
              }
              isDisabled={saving || (!!active && !intent)}
              onPress={() => void generate()}
            >
              {t(intent ? 'check' : selected ? 'regenerate' : 'generate')}
            </Button>
          )}
        {selected?.status === 'succeeded' &&
          detail.data?.id === selected.id &&
          !stale && (
            <TranscriptExportControl
              translation
              recordId={recordId}
              exportPath={`${path}${selected.id}/export/`}
            />
          )}
      </RecordPanelTools>
      <Text>{t('description')}</Text>
      {message && <Text role="alert">{t(message)}</Text>}
      {!selected ? (
        <Text>{t('empty')}</Text>
      ) : (
        <>
          <Text role="status">
            {t(`status.${selected.status}`)}{' '}
            {['queued', 'running'].includes(selected.status) &&
              `${selected.completed_chunks}/${selected.total_chunks}`}
          </Text>
          {stale && <Text role="status">{t('stale')}</Text>}
          {selected.status === 'succeeded' && !detail.data && (
            <Text>{t('loading')}</Text>
          )}
          {detail.data && detail.data.id === selected.id && (
            <>
              {detail.data.results.map((row) => (
                <article
                  style={{
                    contentVisibility: 'auto',
                    containIntrinsicSize: 'auto 160px',
                  }}
                  key={row.segment_id}
                  className={stack}
                >
                  <Text>
                    {row.speaker_name} · {formatClock(row.start_ms)}
                  </Text>
                  {onSource && !stale && (
                    <Button
                      variant="tertiary"
                      size="sm"
                      onPress={() => onSource(row.start_ms)}
                    >
                      {t('play')}
                    </Button>
                  )}
                  <Text variant="note">
                    {t('original')}: {row.text}
                  </Text>
                  <Text>{row.translated_text}</Text>
                </article>
              ))}
              <RecordLoadMore query={detail} disabled={saving} />
            </>
          )}
        </>
      )}
    </section>
  )
}
