import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { css } from '@/styled-system/css'
import {
  captureArchiveApi,
  type CaptureArchive,
} from '../capture/translationArchives'
import { formatDateTime } from '../recordDateTime'

type Source = { viewerId: string; captureId: string; recordId: string }
const options = { retry: false, gcTime: 0, staleTime: 0 }
const layout = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  minWidth: 0,
})
function Pages({
  history,
  next,
  change,
}: {
  history: string[]
  next: string | null
  change: (value: string[]) => void
}) {
  const { t } = useTranslation('capture')
  return (
    <div className={css({ display: 'flex', gap: 'md' })}>
      {history.length > 1 && (
        <Button variant="tertiary" onPress={() => change(history.slice(0, -1))}>
          {t('previous')}
        </Button>
      )}
      {next && !history.includes(next) && (
        <Button variant="tertiary" onPress={() => change([...history, next])}>
          {t('next')}
        </Button>
      )}
    </div>
  )
}
function Content({ source }: { source: Source }) {
  const { t } = useTranslation('capture', { keyPrefix: 'translation.archive' })
  const [selected, setSelected] = useState<CaptureArchive>()
  const [archives, setArchives] = useState([''])
  const [segments, setSegments] = useState([''])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const current = () => alive.current && document.visibilityState === 'visible'
  const list = useQuery({
    ...options,
    // The three IDs fully scope source. The mounted/visible predicate is a lifetime fence.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: [
      'capture-translation-archives',
      source.viewerId,
      source.recordId,
      source.captureId,
      archives.at(-1),
    ],
    enabled: !selected,
    queryFn: ({ signal }) =>
      captureArchiveApi(source, current, signal).list(archives.at(-1)),
  })
  const text = useQuery({
    ...options,
    // Scope IDs and frozen archive metadata determine the read; current only checks lifetime.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: [
      'capture-translation-segments',
      source.viewerId,
      source.recordId,
      source.captureId,
      selected,
      segments.at(-1),
    ],
    enabled: !!selected,
    queryFn: ({ signal }) =>
      captureArchiveApi(source, current, signal).segments(
        selected!,
        segments.at(-1)
      ),
  })
  const pending = selected ? text : list
  const error = pending.isError
  const loading = pending.isFetching || !pending.data
  const refresh = () => void pending.refetch()
  return (
    <section className={layout} aria-label={t('title')}>
      <h2 className={css({ textStyle: 'titleMedium' })}>{t('title')}</h2>
      <p>{t('scope')}</p>
      {selected && (
        <Button
          variant="tertiary"
          onPress={() => {
            setSelected(undefined)
            setSegments([''])
          }}
        >
          {t('back')}
        </Button>
      )}
      <Button
        variant="tertiary"
        isDisabled={pending.isFetching}
        onPress={refresh}
      >
        {t('refresh')}
      </Button>
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
          <Pages
            history={segments}
            next={text.data.next_cursor}
            change={setSegments}
          />
        </>
      ) : list.data ? (
        <>
          {!list.data.results.length && <p>{t('empty')}</p>}
          {list.data.results.map((archive) => (
            <article key={archive.id} className={layout}>
              <Button
                variant="secondary"
                onPress={() => {
                  setSelected(archive)
                  setSegments([''])
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
          <Pages
            history={archives}
            next={list.data.next_cursor}
            change={setArchives}
          />
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
