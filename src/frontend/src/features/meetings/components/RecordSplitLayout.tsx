/* A focusable separator is the WAI-ARIA window splitter pattern. */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { css } from '@/styled-system/css'

/** Resize the existing panes in place, preserving the media element and its clock. */
export function RecordSplitLayout({
  media,
  children,
}: {
  media: ReactNode
  children: (split: boolean) => { details: ReactNode; content: ReactNode }
}) {
  const { t } = useTranslation('capture')
  const container = useRef<HTMLDivElement>(null)
  const mediaContainer = useRef<HTMLDivElement>(null)
  const separator = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
    x: number
    ratio: number
    sign: number
  }>()
  const [available, setAvailable] = useState(0)
  const [requestedRatio, setRequestedRatio] = useState(0.5)
  const [dragging, setDragging] = useState(false)
  const [split, setSplit] = useState(false)
  // Keep both the video controls and the text readable as the app sidebar changes size.
  const minimum =
    available > 0 ? Math.min(0.5, Math.max(0.25, 320 / available)) : 0.25
  const maximum = 1 - minimum
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value))
  const ratio = clamp(requestedRatio)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      const dividerWidth =
        separator.current?.getBoundingClientRect().width ||
        parseFloat(getComputedStyle(document.documentElement).fontSize)
      setAvailable(
        Math.max(0, element.getBoundingClientRect().width - dividerWidth)
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = mediaContainer.current
    if (!element) return
    const wide = window.matchMedia('(min-width: 960px)')
    const update = () =>
      setSplit(
        wide.matches && !!element.querySelector('[data-video-expanded=true]')
      )
    update()
    wide.addEventListener('change', update)
    // The player resolves its media type asynchronously and keeps the same DOM
    // node when collapsed. Only layout state changes; playback is never remounted.
    const observer = new MutationObserver(update)
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-video-expanded'],
    })
    return () => {
      wide.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])

  const finish = () => {
    drag.current = undefined
    setDragging(false)
  }
  const { details, content } = children(split)
  return (
    <div
      ref={container}
      data-record-content
      data-split={split}
      data-resizing={dragging}
      style={{ '--record-video-ratio': ratio } as CSSProperties}
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0',
        minHeight: 0,
        minWidth: 0,
        '& > [data-record-divider]': { display: 'none' },
        '& > [data-record-media]': {
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          minWidth: 0,
          minHeight: 0,
        },
        '&[data-split=false] > [data-record-media]': {
          maxHeight: '45%',
          overflowY: 'auto',
          flexShrink: 1,
        },
        '&[data-resizing=true]': { userSelect: 'none', cursor: 'col-resize' },
        '@media (min-width: 960px)': {
          '&[data-split=true]': {
            flexDirection: 'row',
            '& > [data-record-media]': {
              width: 'calc((100% - 1rem) * var(--record-video-ratio))',
              overflowY: 'auto',
              // A short desktop window must still leave the details readable;
              // let the media column scroll instead of crushing its tab panel.
              '& > [data-record-details]': { minHeight: '12rem' },
            },
            '& > [data-record-divider]': { display: 'flex' },
          },
        },
      })}
    >
      <div ref={mediaContainer} data-record-media>
        {media}
        {details}
      </div>
      <div
        ref={separator}
        data-record-divider
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('resizeVideoPanels')}
        aria-valuemin={Math.round(minimum * 100)}
        aria-valuemax={Math.round(maximum * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`${Math.round(ratio * 100)}% / ${Math.round((1 - ratio) * 100)}%`}
        title={t('resizeVideoPanelsHint')}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || available <= 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            ratio,
            sign:
              getComputedStyle(container.current!).direction === 'rtl' ? -1 : 1,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start || start.pointerId !== event.pointerId || available <= 0)
            return
          setRequestedRatio(
            clamp(
              start.ratio + (start.sign * (event.clientX - start.x)) / available
            )
          )
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return
          finish()
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={() => setRequestedRatio(0.5)}
        onKeyDown={(event) => {
          const sign =
            getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1
          const step = event.shiftKey ? 0.1 : 0.02
          const values: Record<string, number> = {
            ArrowLeft: ratio - sign * step,
            ArrowRight: ratio + sign * step,
            Home: minimum,
            End: maximum,
            Enter: 0.5,
          }
          if (!(event.key in values)) return
          event.preventDefault()
          setRequestedRatio(clamp(values[event.key]))
        }}
        className={css({
          flex: '0 0 1rem',
          width: '1rem',
          alignSelf: 'stretch',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          cursor: 'col-resize',
          touchAction: 'none',
          outline: 'none',
          '&::before': {
            content: '""',
            width: '1px',
            height: '100%',
            backgroundColor: 'border.subtle',
          },
          '&::after': {
            content: '""',
            position: 'absolute',
            width: '0.25rem',
            height: '2rem',
            borderRadius: 'pill',
            backgroundColor: 'border.strong',
          },
          '&:hover, &:focus-visible, [data-resizing=true] &': {
            backgroundColor: 'action.selected.bg',
            '&::before, &::after': { backgroundColor: 'action.primary.bg' },
          },
        })}
      />
      {content}
    </div>
  )
}
