import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { RoomTimelineEntry } from '../api/ApiMeetingRoom'
import { useNowTick } from '../hooks/useNowTick'
import { addMinutes, makeScale } from '../utils/timelineScale'

/** Track pixels per hour. 24h × 64px = 1536px, so a day always scrolls. */
const HOUR_WIDTH = 64
/** Where the track scrolls to on mount — nobody books at 3am. */
const INITIAL_HOUR = 8
const LABEL_WIDTH = '11rem'

const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * Horizontal occupancy board: one row per room, time along the x-axis (P9).
 *
 * Scrolling is a single `overflow-x` container wrapping the ruler *and* every
 * row, with the label column pinned by `position: sticky` — no JS scroll
 * syncing, so the header can never drift a pixel out of step with the grid.
 */
export const RoomTimeline = ({
  rooms,
  dayStart,
  dayEnd,
  isLoading,
  onSelectSlot,
}: {
  rooms: RoomTimelineEntry[]
  dayStart: Date
  dayEnd: Date
  isLoading?: boolean
  /** Click an empty stretch → prefill a new event in that room and slot. */
  onSelectSlot?: (roomId: string, start: Date, end: Date) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const scrollRef = useRef<HTMLDivElement>(null)

  const isToday = new Date().toDateString() === dayStart.toDateString()
  const now = useNowTick(isToday)
  const scale = makeScale(dayStart, dayEnd)
  const trackWidth = HOUR_WIDTH * 24

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = HOUR_WIDTH * INITIAL_HOUR
    }
  }, [dayStart])

  const handleTrackClick = (
    roomId: string,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (!onSelectSlot) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - bounds.left) / bounds.width
    const start = addMinutes(dayStart, scale.snap(scale.minuteAt(ratio)))
    onSelectSlot(roomId, start, addMinutes(start, 60))
  }

  if (!isLoading && rooms.length === 0) {
    return <div className={emptyCls}>{t('pane.empty')}</div>
  }

  return (
    <div className={scrollCls} ref={scrollRef} data-testid="mr-timeline">
      <div style={{ width: `calc(${LABEL_WIDTH} + ${trackWidth}px)` }}>
        {/* Ruler */}
        <div className={rulerCls}>
          <div className={labelHeadCls} style={{ width: LABEL_WIDTH }}>
            {t('timeline.roomColumn')}
          </div>
          <div className={rulerTrackCls} style={{ width: trackWidth }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                className={tickCls}
                style={{ width: HOUR_WIDTH }}
              >
                {String(hour).padStart(2, '0')}:00
              </div>
            ))}
          </div>
        </div>

        <div className={bodyCls}>
          {isToday && (
            <div
              className={nowLineCls}
              data-testid="mr-now-line"
              style={{
                left: `calc(${LABEL_WIDTH} + ${(scale.pct(now) / 100) * trackWidth}px)`,
              }}
            />
          )}
          {rooms.map((room) => (
            <div key={room.id} className={rowCls} data-testid={`mr-timeline-row-${room.id}`}>
              <div className={labelCellCls} style={{ width: LABEL_WIDTH }}>
                <span className={roomNameCls}>{room.name}</span>
                <span className={roomMetaCls}>
                  {room.path_label}
                  {room.capacity > 0 &&
                    ` · ${t('unit.people', { count: room.capacity })}`}
                </span>
              </div>
              <div
                className={trackCls}
                style={{ width: trackWidth }}
                onClick={(e) => handleTrackClick(room.id, e)}
                role={onSelectSlot ? 'button' : undefined}
                tabIndex={onSelectSlot ? 0 : undefined}
                aria-label={t('timeline.clickToBook', { room: room.name })}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <div
                    key={hour}
                    className={gridLineCls}
                    style={{ left: hour * HOUR_WIDTH }}
                  />
                ))}
                {room.bookings.map((booking) => (
                  <div
                    key={booking.id}
                    data-testid={`mr-timeline-block-${booking.id}`}
                    title={`${timeLabel(booking.start)}–${timeLabel(booking.end)}${
                      booking.title ? ` · ${booking.title}` : ''
                    }`}
                    className={booking.is_mine ? blockMineCls : blockCls}
                    style={{
                      left: `${scale.pct(booking.start)}%`,
                      width: `${scale.widthPct(booking.start, booking.end)}%`,
                    }}
                  >
                    {booking.title ?? t('timeline.booked')}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const scrollCls = css({
  overflowX: 'auto',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
})
const rulerCls = css({
  display: 'flex',
  position: 'sticky',
  top: 0,
  zIndex: 2,
  backgroundColor: 'greyscale.50',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const labelHeadCls = css({
  position: 'sticky',
  left: 0,
  zIndex: 3,
  flexShrink: 0,
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  fontSize: '0.75rem',
  color: 'greyscale.600',
  backgroundColor: 'greyscale.50',
  borderRight: '1px solid token(colors.greyscale.200)',
})
const rulerTrackCls = css({ display: 'flex', flexShrink: 0 })
const tickCls = css({
  flexShrink: 0,
  paddingY: '0.5rem',
  paddingLeft: '0.25rem',
  fontSize: '0.6875rem',
  color: 'greyscale.500',
  borderLeft: '1px solid token(colors.greyscale.100)',
})
const bodyCls = css({ position: 'relative' })
const rowCls = css({
  display: 'flex',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const labelCellCls = css({
  position: 'sticky',
  left: 0,
  zIndex: 1,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '0.125rem',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  backgroundColor: 'greyscale.000',
  borderRight: '1px solid token(colors.greyscale.200)',
})
const roomNameCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const roomMetaCls = css({
  fontSize: '0.6875rem',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const trackCls = css({
  position: 'relative',
  flexShrink: 0,
  height: '2.75rem',
  cursor: 'pointer',
})
const gridLineCls = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: '1px',
  backgroundColor: 'greyscale.100',
})
const blockBase = {
  position: 'absolute',
  top: '0.375rem',
  bottom: '0.375rem',
  paddingX: '0.375rem',
  borderRadius: '0.25rem',
  fontSize: '0.6875rem',
  lineHeight: '1.6rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const
// Two complete classes instead of cx-layering: atomic classes resolve by
// stylesheet order, so conditionally stacking colour utilities is a coin flip.
const blockCls = css({
  ...blockBase,
  backgroundColor: 'greyscale.300',
  color: 'greyscale.800',
})
const blockMineCls = css({
  ...blockBase,
  backgroundColor: 'primary.500',
  color: 'white',
  _dark: { backgroundColor: 'primaryDark.500', color: 'greyscale.1000' },
})
const nowLineCls = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: '2px',
  backgroundColor: 'danger.500',
  zIndex: 1,
  pointerEvents: 'none',
})
const emptyCls = css({
  padding: '2rem',
  textAlign: 'center',
  fontSize: '0.875rem',
  color: 'greyscale.500',
})
