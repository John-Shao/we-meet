import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react'
import { RiArrowUpSLine, RiArrowDownSLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '@/primitives/IconButton'
import { css } from '@/styled-system/css'

/** Counts only rendered matches: the API returns cursor pages, not a global total. */
export function TranscriptSearchNavigation({
  containerRef,
  query,
  version,
  pagination,
}: {
  containerRef: RefObject<HTMLDivElement>
  query: string
  version: unknown
  pagination?: ReactNode
}) {
  const { t } = useTranslation('meetings')
  const marks = useRef<HTMLElement[]>([])
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(-1)
  useEffect(() => {
    const container = containerRef.current
    setCount(0)
    setIndex(-1)
    const readMatches = () => {
      const next = Array.from(
        container?.querySelectorAll<HTMLElement>('mark') ?? []
      )
      if (
        next.length === marks.current.length &&
        next.every((mark, i) => mark === marks.current[i])
      )
        return
      marks.current.forEach((mark) =>
        mark.removeAttribute('data-search-current')
      )
      marks.current = next
      setCount(next.length)
      setIndex(-1)
    }
    readMatches()
    // Segment editing and asynchronously loaded word alignment can replace marks
    // without changing the query page. Ignore attributes changed by playback.
    const observer = new MutationObserver(readMatches)
    if (container)
      observer.observe(container, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      marks.current.forEach((mark) =>
        mark.removeAttribute('data-search-current')
      )
      marks.current = []
    }
  }, [containerRef, query, version])
  const move = (next: number) => {
    const mark = marks.current[next]
    if (!mark?.isConnected) return
    marks.current[index]?.removeAttribute('data-search-current')
    mark.dataset.searchCurrent = 'true'
    // Scroll only the transcript viewport, never the media pane or the page.
    const scroll = mark.closest<HTMLElement>('[data-transcript-scroll]')
    if (scroll) {
      scroll.scrollTop +=
        mark.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        scroll.clientHeight / 3
    } else mark.scrollIntoView?.({ block: 'nearest' })
    setIndex(next)
  }
  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'xs',
        textStyle: 'bodySmall',
        color: 'text.secondary',
      })}
    >
      <span role="status">
        {t('transcriptToolbar.matches', { current: index + 1, total: count })}
      </span>
      <IconButton
        label={t('transcriptToolbar.previousMatch')}
        size="icon32"
        isDisabled={index <= 0}
        onPress={() => move(index - 1)}
      >
        <RiArrowUpSLine size={16} aria-hidden />
      </IconButton>
      <IconButton
        label={t('transcriptToolbar.nextMatch')}
        size="icon32"
        isDisabled={index + 1 >= count}
        onPress={() => move(index + 1)}
      >
        <RiArrowDownSLine size={16} aria-hidden />
      </IconButton>
      {pagination}
    </div>
  )
}
