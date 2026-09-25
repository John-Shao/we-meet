import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RiRefreshLine } from '@remixicon/react'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

type ReadState = {
  hasNextPage: boolean
  isFetching: boolean
  isFetchNextPageError: boolean
  loadError: unknown
  loadMore: () => void
  refetch: () => unknown
}

export function RecordRefreshButton({
  busy,
  disabled,
  onRefresh,
}: {
  busy: boolean
  disabled?: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation('meetings')
  return (
    <Button
      size="sm"
      variant="secondaryText"
      icon={<RiRefreshLine size={16} aria-hidden />}
      loading={busy}
      isDisabled={disabled || busy}
      onPress={onRefresh}
    >
      {t('library.refresh')}
    </Button>
  )
}

/** Observe the panel's own scroll viewport, never the whole workspace. */
export function RecordLoadMore({
  query,
  disabled = false,
}: {
  query: ReadState
  disabled?: boolean
}) {
  const { t } = useTranslation('meetings')
  const ref = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetching, loadError, loadMore } = query
  useEffect(() => {
    const node = ref.current
    if (
      !node ||
      !hasNextPage ||
      isFetching ||
      loadError ||
      disabled ||
      !('IntersectionObserver' in window)
    )
      return
    let root = node.parentElement
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY))
      root = root.parentElement
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore()
      },
      { root, rootMargin: '0px 0px 240px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetching, loadError, loadMore, disabled])
  return (
    <div
      ref={ref}
      className={css({
        paddingY: 'md',
        textAlign: 'center',
        color: 'text.secondary',
      })}
    >
      {query.isFetching ? (
        <span role="status">{t('continuous.loading')}</span>
      ) : query.loadError ? (
        <Button
          size="sm"
          variant="secondaryText"
          isDisabled={disabled}
          onPress={() =>
            query.isFetchNextPageError ? query.loadMore() : void query.refetch()
          }
        >
          {t('continuous.retry')}
        </Button>
      ) : query.hasNextPage ? (
        <Button
          size="sm"
          variant="secondaryText"
          isDisabled={disabled}
          onPress={query.loadMore}
        >
          {t('continuous.more')}
        </Button>
      ) : (
        <span role="status">{t('continuous.end')}</span>
      )}
    </div>
  )
}
