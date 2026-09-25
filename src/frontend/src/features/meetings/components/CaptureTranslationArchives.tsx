import { RecordPanelTools } from './RecordPanel'
import { useEffect, useRef, useState } from 'react'
import { useRecordInfiniteQuery } from '../hooks/useRecordInfiniteQuery'
import { RecordLoadMore } from './RecordLoadMore'
import { useTranslation } from 'react-i18next'
import { RiArrowLeftLine, RiRefreshLine } from '@remixicon/react'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { css } from '@/styled-system/css'
import {
  captureArchiveApi,
  type CaptureArchive,
} from '../capture/translationArchives'
import { formatDateTime } from '../recordDateTime'

type Source = { viewerId: string; captureId: string; recordId: string }
const layout = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  minWidth: 0,
})
function Content({ source }: { source: Source }) {
  const { t } = useTranslation('capture', { keyPrefix: 'translation.archive' })
  const [selected, setSelected] = useState<CaptureArchive>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const current = () => alive.current && document.visibilityState === 'visible'
  const list = useRecordInfiniteQuery({
    initialPageParam: '',
    // The three IDs fully scope source. The mounted/visible predicate is a lifetime fence.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: [
      'capture-translation-archives',
      source.viewerId,
      source.recordId,
      source.captureId,
    ],
    enabled: !selected,
    queryFn: ({ signal, pageParam }) =>
      captureArchiveApi(source, current, signal).list(pageParam),
  })
  const text = useRecordInfiniteQuery({
    initialPageParam: '',
    // Scope IDs and frozen archive metadata determine the read; current only checks lifetime.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: [
      'capture-translation-segments',
      source.viewerId,
      source.recordId,
      source.captureId,
      selected,
    ],
    enabled: !!selected,
    queryFn: ({ signal, pageParam }) =>
      captureArchiveApi(source, current, signal).segments(selected!, pageParam),
  })
  const pending = selected ? text : list
  const error = pending.isError
  const loading = !pending.data
  const refresh = () => void pending.refetch()
  return (
    <section className={layout} aria-label={t('title')}>
      <h2 className={css({ textStyle: 'titleMedium' })}>{t('title')}</h2>
      <p>{t('scope')}</p>
      <RecordPanelTools>
        {selected && (
          <Button
            size="sm"
            variant="secondaryText"
            icon={<RiArrowLeftLine size={16} aria-hidden />}
            onPress={() => {
              setSelected(undefined)
            }}
          >
            {t('back')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondaryText"
          icon={<RiRefreshLine size={16} aria-hidden />}
          isDisabled={pending.isFetching}
          onPress={refresh}
        >
          {t('refresh')}
        </Button>
      </RecordPanelTools>
      {error ? (
        // 恢复动作是上面那颗面板级的「刷新」，这里不再重复一颗（StateHint 的 action 槽
        // 留给没有其它恢复入口的地方）。
        <StateHint state="error">{t('error')}</StateHint>
      ) : loading ? (
        <StateHint state="loading">{t('loading')}</StateHint>
      ) : selected && text.data ? (
        <>
          <p role="status">{t(`status.${text.data.archive_status}`)}</p>
          {text.data.archive_status === 'incomplete' && (
            <p role="note">{t('incomplete')}</p>
          )}
          <p>{t('timing')}</p>
          {!text.data.results.length && <p>{t('emptyText')}</p>}
          {text.data.results.map((row) => (
            <article
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: 'auto 160px',
              }}
              key={row.id}
              className={css({
                borderBottom: '1px solid',
                borderColor: 'border.subtle',
                paddingY: 'md',
              })}
            >
              <p
                className={css({
                  textStyle: 'bodyMedium',
                  color: 'text.secondary',
                })}
              >
                {t(`language.${row.target}`)} ·{' '}
                {t('received', {
                  time: formatDateTime(row.received_at),
                })}
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
          <RecordLoadMore query={text} />
        </>
      ) : list.data ? (
        <>
          {!list.data.results.length && <p>{t('empty')}</p>}
          {list.data.results.map((archive) => (
            <article
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: 'auto 160px',
              }}
              key={archive.id}
              className={layout}
            >
              <Button
                variant="secondary"
                onPress={() => {
                  setSelected(archive)
                }}
              >
                {t('open', {
                  date: formatDateTime(archive.created_at),
                  generation: archive.generation,
                })}
              </Button>
              <p>
                {t(`mode.${archive.configuration.mode}`)} ·{' '}
                {t(`language.${archive.configuration.source_language}`)} →{' '}
                {t(`language.${archive.configuration.target_language}`)} ·{' '}
                {t(`status.${archive.status}`)} ·{' '}
                {t('count', { count: archive.segment_count })}
              </p>
            </article>
          ))}
          <RecordLoadMore query={list} />
        </>
      ) : null}
    </section>
  )
}

/** Unmount private queries on backgrounding and reload after returning. No persistent text. */
export function CaptureTranslationArchives(source: Source) {
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  return visible ? (
    <Content
      key={`${source.viewerId}:${source.recordId}:${source.captureId}`}
      source={source}
    />
  ) : null
}
