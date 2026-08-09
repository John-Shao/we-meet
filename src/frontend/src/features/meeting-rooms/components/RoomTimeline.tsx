import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import type {
  TimeRangeMode,
  WorkingHours,
} from '@/features/calendar/utils/workingHours'
import {
  clipRangeToWindow,
  workingWindowForDate,
} from '@/features/calendar/utils/workingHours'

import type { MeetingRoomBrief, RoomTimelineEntry } from '../api/ApiMeetingRoom'
import { useNowTick } from '../hooks/useNowTick'
import { addMinutes, makeScale } from '../utils/timelineScale'

/** Readable hourly minimum; wider viewports distribute the visible range. */
const HOUR_WIDTH = 48
/** Where the track scrolls to on mount — nobody books at 3am. */
const INITIAL_HOUR = 8
const LABEL_WIDTH_PX = 176
const LABEL_WIDTH = `${LABEL_WIDTH_PX}px`

const timeLabel = (value: string | Date) =>
  (value instanceof Date ? value : new Date(value)).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
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
  workingHours,
  timeRangeMode,
  isLoading,
  emptyMessage,
  selectedSlot,
  onSelectSlot,
  onSlotChange,
}: {
  rooms: RoomTimelineEntry[]
  dayStart: Date
  dayEnd: Date
  workingHours: WorkingHours
  timeRangeMode: TimeRangeMode
  isLoading?: boolean
  emptyMessage?: string
  selectedSlot?: { roomId: string; start: Date; end: Date } | null
  /** Click an empty stretch → prefill a new event in that room and slot. */
  onSelectSlot?: (room: MeetingRoomBrief, start: Date, end: Date) => void
  /** Move or resize the selected slot without opening the create dialog. */
  onSlotChange?: (room: MeetingRoomBrief, start: Date, end: Date) => void
}) => {
  const { t } = useTranslation(['meeting-rooms', 'calendar'])
  const scrollRef = useRef<HTMLDivElement>(null)
  const suppressClickRef = useRef(false)
  const [viewportWidth, setViewportWidth] = useState(0)

  const isToday = new Date().toDateString() === dayStart.toDateString()
  const now = useNowTick(isToday)
  const scale = makeScale(dayStart, dayEnd)
  const totalMinutes = scale.minuteAt(1)
  const halfHourCount = Math.ceil(totalMinutes / 30)
  // Keep 48px/hour as the readable minimum, but distribute a wide viewport
  // across the selected range instead of leaving an empty strip on the right.
  const trackWidth = Math.max(
    HOUR_WIDTH * (totalMinutes / 60),
    viewportWidth - LABEL_WIDTH_PX
  )
  const workWindow = workingWindowForDate(dayStart, workingHours)
  const axisTicks = Array.from({ length: halfHourCount }, (_, index) => {
    const minute = index * 30
    return { minute, value: addMinutes(dayStart, minute) }
  })

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const update = () => setViewportWidth(node.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      const targetMinute = timeRangeMode === 'full' ? workingHours.startMin : 0
      scrollRef.current.scrollLeft = (targetMinute / totalMinutes) * trackWidth
    }
  }, [dayStart, timeRangeMode, totalMinutes, trackWidth, workingHours.startMin])

  const handleTrackClick = (
    room: RoomTimelineEntry,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (!onSelectSlot) return
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - bounds.left) / bounds.width
    const startMinute = Math.min(
      scale.snap(scale.minuteAt(ratio)),
      Math.max(0, totalMinutes - 30)
    )
    const start = addMinutes(dayStart, startMinute)
    onSelectSlot(
      room,
      start,
      addMinutes(start, Math.min(60, totalMinutes - startMinute))
    )
  }

  const beginDraftDrag = (
    mode: 'move' | 'start' | 'end',
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (!selectedSlot || !onSlotChange) return
    event.preventDefault()
    event.stopPropagation()

    const originX = event.clientX
    const originY = event.clientY
    const originStart = scale.minuteAt(scale.pct(selectedSlot.start) / 100)
    const originEnd = scale.minuteAt(scale.pct(selectedSlot.end) / 100)
    const duration = originEnd - originStart
    let moved = false

    const roomAt = (clientY: number) => {
      if (mode !== 'move') {
        return rooms.find((room) => room.id === selectedSlot.roomId)
      }
      return rooms.find((room) => {
        const row = scrollRef.current?.querySelector<HTMLElement>(
          `[data-room-row="${CSS.escape(room.id)}"]`
        )
        if (!row) return false
        const bounds = row.getBoundingClientRect()
        return clientY >= bounds.top && clientY <= bounds.bottom
      })
    }

    const onMove = (pointer: PointerEvent) => {
      const dx = pointer.clientX - originX
      const dy = pointer.clientY - originY
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      moved = true

      const rawDelta = (dx / trackWidth) * totalMinutes
      const delta = Math.round(rawDelta / 30) * 30
      let startMinute = originStart
      let endMinute = originEnd

      if (mode === 'move') {
        startMinute = Math.max(
          0,
          Math.min(originStart + delta, totalMinutes - duration)
        )
        endMinute = startMinute + duration
      } else if (mode === 'start') {
        startMinute = Math.max(0, Math.min(originStart + delta, originEnd - 30))
      } else {
        endMinute = Math.min(
          totalMinutes,
          Math.max(originEnd + delta, originStart + 30)
        )
      }

      const room = roomAt(pointer.clientY)
      if (!room) return
      onSlotChange(
        room,
        addMinutes(dayStart, startMinute),
        addMinutes(dayStart, endMinute)
      )
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      if (moved) {
        suppressClickRef.current = true
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = mode === 'move' ? 'move' : 'ew-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleTrackKeyDown = (
    room: RoomTimelineEntry,
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    if (!onSelectSlot || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    const nowMinute = (now.getTime() - dayStart.getTime()) / 60_000
    const fallbackMinute = timeRangeMode === 'full' ? INITIAL_HOUR * 60 : 0
    const baseMinute =
      isToday && nowMinute >= 0 && nowMinute < totalMinutes
        ? Math.ceil(nowMinute / 30) * 30
        : fallbackMinute
    const startMinute = Math.min(baseMinute, Math.max(0, totalMinutes - 60))
    const start = addMinutes(dayStart, startMinute)
    onSelectSlot(room, start, addMinutes(start, Math.min(60, totalMinutes)))
  }

  const handleDraftKeyDown = (
    room: RoomTimelineEntry,
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    if (!selectedSlot) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectSlot?.(room, selectedSlot.start, selectedSlot.end)
      return
    }
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      return
    }
    event.preventDefault()
    if (!onSlotChange) return

    const roomIndex = rooms.findIndex((candidate) => candidate.id === room.id)
    const targetRoom =
      event.key === 'ArrowUp'
        ? rooms[Math.max(0, roomIndex - 1)]
        : event.key === 'ArrowDown'
          ? rooms[Math.min(rooms.length - 1, roomIndex + 1)]
          : room
    let startMinute = scale.minuteAt(scale.pct(selectedSlot.start) / 100)
    let endMinute = scale.minuteAt(scale.pct(selectedSlot.end) / 100)

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowLeft' ? -30 : 30
      if (event.shiftKey) {
        endMinute = Math.max(
          startMinute + 30,
          Math.min(totalMinutes, endMinute + delta)
        )
      } else {
        const duration = endMinute - startMinute
        startMinute = Math.max(
          0,
          Math.min(totalMinutes - duration, startMinute + delta)
        )
        endMinute = startMinute + duration
      }
    }
    onSlotChange(
      targetRoom,
      addMinutes(dayStart, startMinute),
      addMinutes(dayStart, endMinute)
    )
  }

  if (!isLoading && rooms.length === 0) {
    return <div className={emptyCls}>{emptyMessage ?? t('pane.empty')}</div>
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
            {axisTicks.map(({ minute, value }) => (
              <div
                key={minute}
                className={tickCls}
                style={{ width: `${(30 / totalMinutes) * 100}%` }}
              >
                {minute === 0 || value.getMinutes() === 0
                  ? timeLabel(value)
                  : null}
              </div>
            ))}
          </div>
        </div>

        <div className={bodyCls}>
          {isToday && now >= dayStart && now < dayEnd && (
            <div
              className={nowLineCls}
              data-testid="mr-now-line"
              style={{
                left: `calc(${LABEL_WIDTH} + ${(scale.pct(now) / 100) * trackWidth}px)`,
              }}
            />
          )}
          {rooms.map((room) => (
            <div
              key={room.id}
              className={rowCls}
              data-room-row={room.id}
              data-testid={`mr-timeline-row-${room.id}`}
            >
              <div className={labelCellCls} style={{ width: LABEL_WIDTH }}>
                <span className={roomNameCls} title={room.name}>
                  {room.name}
                </span>
                <span className={roomMetaCls} title={room.path_label}>
                  {room.path_label}
                </span>
                <span
                  className={roomResourceCls}
                  title={room.facilities
                    .map((facility) => facility.name)
                    .join(' · ')}
                >
                  {room.capacity > 0 &&
                    t('unit.people', { count: room.capacity })}
                  {room.capacity > 0 && room.facilities.length > 0 && ' · '}
                  {room.facilities
                    .slice(0, 2)
                    .map((facility) => facility.name)
                    .join(' · ')}
                </span>
              </div>
              <div
                className={trackCls}
                style={{ width: trackWidth }}
                onClick={(e) => handleTrackClick(room, e)}
                onKeyDown={(e) => handleTrackKeyDown(room, e)}
                role={onSelectSlot ? 'button' : undefined}
                tabIndex={onSelectSlot ? 0 : undefined}
                aria-label={t('timeline.clickToBook', { room: room.name })}
              >
                {timeRangeMode === 'full' && (
                  <>
                    <div
                      className={nonWorkingShadeCls}
                      style={{
                        left: 0,
                        width: `${scale.pct(workWindow.start)}%`,
                      }}
                    />
                    <div
                      className={nonWorkingShadeCls}
                      style={{
                        left: `${scale.pct(workWindow.end)}%`,
                        right: 0,
                      }}
                    />
                  </>
                )}
                {axisTicks.map(({ minute }) => (
                  <div
                    key={minute}
                    className={gridLineCls}
                    style={{ left: `${(minute / totalMinutes) * 100}%` }}
                  />
                ))}
                {selectedSlot?.roomId === room.id && (
                  <div
                    data-testid="mr-timeline-draft"
                    className={draftBlockCls}
                    role="button"
                    tabIndex={0}
                    aria-label={t('timeline.clickToBook', { room: room.name })}
                    onPointerDown={(event) => beginDraftDrag('move', event)}
                    onKeyDown={(event) => handleDraftKeyDown(room, event)}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (event.target !== event.currentTarget) return
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false
                        return
                      }
                      onSelectSlot?.(room, selectedSlot.start, selectedSlot.end)
                    }}
                    style={{
                      left: `${scale.pct(selectedSlot.start)}%`,
                      width: `${scale.widthPct(
                        selectedSlot.start,
                        selectedSlot.end
                      )}%`,
                    }}
                  >
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      className={draftHandleStartCls}
                      onPointerDown={(event) => beginDraftDrag('start', event)}
                    />
                    <span className={draftTextCls}>
                      {timeLabel(selectedSlot.start)}–
                      {timeLabel(selectedSlot.end)}{' '}
                      {t('calendar:grid.draftAdd')}
                    </span>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      className={draftHandleEndCls}
                      onPointerDown={(event) => beginDraftDrag('end', event)}
                    />
                  </div>
                )}
                {room.bookings.map((booking) => {
                  const bookingStart = new Date(booking.start)
                  const bookingEnd = new Date(booking.end)
                  const clipped = clipRangeToWindow(
                    bookingStart,
                    bookingEnd,
                    dayStart,
                    dayEnd
                  )
                  if (!clipped) return null
                  return (
                    <div
                      key={booking.id}
                      data-testid={`mr-timeline-block-${booking.id}`}
                      title={`${timeLabel(booking.start)}–${timeLabel(booking.end)}${
                        booking.title ? ` · ${booking.title}` : ''
                      }`}
                      className={booking.is_mine ? blockMineCls : blockCls}
                      style={{
                        left: `${scale.pct(clipped.start)}%`,
                        width: `${scale.widthPct(clipped.start, clipped.end)}%`,
                      }}
                    >
                      {booking.title ?? t('timeline.booked')}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const scrollCls = css({
  flex: 1,
  minHeight: 0,
  height: '100%',
  overflowY: 'auto',
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
const roomResourceCls = css({
  fontSize: '0.6875rem',
  color: 'greyscale.600',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const trackCls = css({
  position: 'relative',
  flexShrink: 0,
  height: '3.5rem',
  cursor: 'pointer',
})
const gridLineCls = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: '1px',
  backgroundColor: 'greyscale.100',
})
const nonWorkingShadeCls = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  backgroundColor: 'greyscale.50',
  pointerEvents: 'none',
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
const draftBlockCls = css({
  ...blockBase,
  backgroundColor: 'primary.100',
  color: 'primary.700',
  border: '1px solid token(colors.primary.500)',
  cursor: 'move',
  userSelect: 'none',
  overflow: 'visible',
  zIndex: 1,
  _dark: {
    backgroundColor: 'primaryDark.100',
    color: 'primaryDark.800',
    borderColor: 'primaryDark.500',
  },
})
const draftTextCls = css({
  display: 'block',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
})
const draftHandleBase = {
  position: 'absolute',
  top: '50%',
  width: '0.75rem',
  height: '0.75rem',
  border: '2px solid token(colors.primary.500)',
  borderRadius: '50%',
  backgroundColor: 'greyscale.000',
  cursor: 'ew-resize',
  transform: 'translateY(-50%)',
  zIndex: 2,
  _after: {
    content: '""',
    position: 'absolute',
    inset: '-0.5rem',
  },
} as const
const draftHandleStartCls = css({
  ...draftHandleBase,
  left: '-0.4375rem',
})
const draftHandleEndCls = css({
  ...draftHandleBase,
  right: '-0.4375rem',
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
