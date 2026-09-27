import { useRecordInfiniteQuery } from '../hooks/useRecordInfiniteQuery'
import { RecordLoadMore, RecordRefreshButton } from './RecordLoadMore'
import { useRecordViewState } from '../hooks/useRecordViewState'
import { useTranslationViewPreferences } from '../hooks/useTranslationViewPreferences'
import { activeRowId } from '../transcriptSync'
import { RecordPanelTools } from './RecordPanel'
import { TranscriptExportControl } from './TranscriptExportControl'
import { selectChrome } from '@/primitives/selectChrome'
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  RiCheckLine,
  RiInformationLine,
  RiPlayFill,
  RiRefreshLine,
  RiTranslate2,
} from '@remixicon/react'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { Button, Popover, Text } from '@/primitives'
import { css } from '@/styled-system/css'

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
// Translation timestamps are offsets in the source media, not wall-clock dates.
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export function UploadTranslationPanel({
  viewerId,
  recordId,
  onSource,
  positionMs,
}: {
  viewerId: string
  recordId: string
  onSource?: (milliseconds: number) => void
  positionMs?: number
}) {
  const { t } = useTranslation('meetings', { keyPrefix: 'uploadTranslation' })
  const path = `meeting-records/${recordId}/upload-translations/`
  const [preferences, setPreferences] = useTranslationViewPreferences(viewerId)
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
    // HTTP success does not mean the translation is still active. Stop polling
    // terminal jobs; an explicit retry refetches the list and resumes polling.
    refetchInterval: (q) =>
      !q.state.error &&
      q.state.data?.results.some((item) =>
        ['queued', 'running'].includes(item.status)
      )
        ? 5000
        : false,
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
            end_ms?: number | null
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
  const rows = detail.data?.results ?? []
  const currentId =
    !stale && onSource && positionMs !== undefined
      ? activeRowId(
          rows.map((row, index) => ({
            id: row.segment_id,
            start_ms: row.start_ms,
            end_ms: row.end_ms ?? rows[index + 1]?.start_ms ?? row.start_ms,
          })),
          positionMs
        )
      : null
  const canGenerate =
    listing.data.can_generate &&
    (intent || !selected || selected.status !== 'succeeded' || stale)
  return (
    <section
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
        minWidth: 0,
        containerType: 'inline-size',
      })}
      aria-label={t('title')}
    >
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
        <Button
          size="sm"
          variant="secondaryText"
          aria-pressed={preferences.showOriginal}
          icon={
            preferences.showOriginal ? (
              <RiCheckLine size={16} aria-hidden />
            ) : undefined
          }
          className={css({
            '&[aria-pressed="true"]': { backgroundColor: 'action.selected.bg' },
          })}
          onPress={() =>
            setPreferences({ showOriginal: !preferences.showOriginal })
          }
        >
          {t('showOriginal')}
        </Button>
        {preferences.showOriginal && (
          <Button
            size="sm"
            variant="secondaryText"
            aria-pressed={preferences.sideBySide}
            className={css({
              display: 'none',
              '&[aria-pressed="true"]': {
                backgroundColor: 'action.selected.bg',
              },
              '@container (min-width: 48rem)': { display: 'inline-flex' },
            })}
            onPress={() =>
              setPreferences({ sideBySide: !preferences.sideBySide })
            }
          >
            {t('sideBySide')}
          </Button>
        )}
        {selected?.status === 'succeeded' && (
          <Text variant="note" role="status">
            {t('status.succeeded')}
          </Text>
        )}
        <Popover aria-label={t('info')}>
          <Button
            size="sm"
            variant="secondaryText"
            aria-label={t('info')}
            icon={<RiInformationLine size={16} aria-hidden />}
          />
          <Text className={css({ maxWidth: 'min(20rem, 80vw)' })}>
            {t('description')}
          </Text>
        </Popover>
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
      {canGenerate && <Text variant="note">{t('generationHint')}</Text>}
      {message && <Text role="alert">{t(message)}</Text>}
      {!selected ? (
        <Text>{t('empty')}</Text>
      ) : (
        <>
          {selected.status !== 'succeeded' && (
            <Text role="status">
              {t(`status.${selected.status}`)}{' '}
              {['queued', 'running'].includes(selected.status) &&
                `${selected.completed_chunks}/${selected.total_chunks}`}
            </Text>
          )}
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
                  data-active={row.segment_id === currentId || undefined}
                  aria-current={
                    row.segment_id === currentId ? 'true' : undefined
                  }
                  className={css({
                    paddingY: 'sm',
                    paddingX: 'md',
                    minWidth: 0,
                    borderBottomWidth: '1px',
                    borderColor: 'border.subtle',
                    borderInlineStartWidth: '3px',
                    borderInlineStartColor: 'transparent',
                    '&[data-active]': {
                      backgroundColor: 'action.selected.bg',
                      borderInlineStartColor: 'text.link',
                    },
                  })}
                >
                  <div
                    className={css({
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'sm',
                      minWidth: 0,
                    })}
                  >
                    <Text
                      variant="note"
                      className={css({
                        flex: 1,
                        minWidth: 0,
                        overflowWrap: 'anywhere',
                      })}
                    >
                      {!row.speaker_name.trim() ||
                      row.speaker_name.trim().toLowerCase() === 'unknown'
                        ? t('unknownSpeaker')
                        : row.speaker_name}
                      {row.segment_id === currentId && (
                        <span> · {t('currentSegment')}</span>
                      )}
                    </Text>
                    {onSource && !stale ? (
                      <Button
                        variant="secondaryText"
                        size="sm"
                        aria-label={`${t('play')} ${time(row.start_ms)}`}
                        icon={<RiPlayFill size={16} aria-hidden />}
                        className={css({
                          flexShrink: 0,
                          minHeight: '44px',
                          fontVariantNumeric: 'tabular-nums',
                        })}
                        onPress={() => onSource(row.start_ms)}
                      >
                        {time(row.start_ms)}
                      </Button>
                    ) : (
                      <Text variant="note">{time(row.start_ms)}</Text>
                    )}
                  </div>
                  <div
                    data-compare={
                      (preferences.showOriginal && preferences.sideBySide) ||
                      undefined
                    }
                    className={css({
                      display: 'grid',
                      gap: 'sm',
                      paddingBottom: 'sm',
                      '& p': {
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        minWidth: 0,
                        lineHeight: 1.7,
                      },
                      '@container (min-width: 48rem)': {
                        '&[data-compare]': {
                          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                          columnGap: 'lg',
                          '& [data-original]': { gridColumn: 1, gridRow: 1 },
                        },
                      },
                    })}
                  >
                    <Text lang={target}>{row.translated_text}</Text>
                    {preferences.showOriginal && (
                      <Text variant="note" data-original>
                        {row.text}
                      </Text>
                    )}
                  </div>
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
