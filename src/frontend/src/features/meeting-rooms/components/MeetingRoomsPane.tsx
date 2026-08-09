import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { useCalendarSettings } from '@/features/calendar/hooks/useCalendarSettings'
import { TimeRangeSwitcher } from '@/features/calendar/components/CalendarToolbar'
import {
  isOutsideWorkingHours,
  workingWindowForDate,
} from '@/features/calendar/utils/workingHours'

import type { RoomFilters } from '../api/ApiMeetingRoom'
import type { MeetingRoomBrief } from '../api/ApiMeetingRoom'
import { fetchMeetingRoomTimeline } from '../api/fetchMeetingRooms'
import { dayWindow } from '../utils/timelineScale'
import { MeetingRoomFilters } from './MeetingRoomFilters'
import { RoomTimeline } from './RoomTimeline'

/**
 * The 「会议室」 tab: filters + a day's occupancy across every matching room.
 *
 * Renders in the viewer's own timezone (M1). A level's timezone is shown next
 * to its rooms but does not shift the axis — cross-timezone rendering is a
 * larger question than this tab needs to answer.
 */
export const MeetingRoomsPane = ({
  date,
  selectedSlot,
  onSelectSlot,
  onSlotChange,
  onClearSlot,
}: {
  date: Date
  selectedSlot?: { roomId: string; start: Date; end: Date } | null
  onSelectSlot?: (room: MeetingRoomBrief, start: Date, end: Date) => void
  onSlotChange?: (room: MeetingRoomBrief, start: Date, end: Date) => void
  onClearSlot?: () => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const [filters, setFilters] = useState<RoomFilters>({})
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const {
    workingHours,
    meetingRoomsTimeRangeMode,
    setMeetingRoomsTimeRangeMode,
  } = useCalendarSettings()

  const { start: dayStart, end: dayEnd } = dayWindow(date)
  const visibleWindow =
    meetingRoomsTimeRangeMode === 'work'
      ? workingWindowForDate(date, workingHours)
      : { start: dayStart, end: dayEnd }
  const startIso = dayStart.toISOString()
  const endIso = dayEnd.toISOString()

  const { data, isFetching, isError, refetch } = useQuery({
    /* eslint-disable @tanstack/query/exhaustive-deps */
    queryKey: [
      'meeting-rooms',
      'timeline',
      startIso,
      filters.node ?? '',
      filters.q?.trim() ?? '',
      filters.capacityMin ?? 0,
      (filters.facilityIds ?? []).slice().sort().join(','),
    ],
    /* eslint-enable @tanstack/query/exhaustive-deps */
    queryFn: () => fetchMeetingRoomTimeline(startIso, endIso, filters),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  })

  const visibleRooms = useMemo(() => {
    const rooms = data?.results ?? []
    if (!onlyAvailable) return rooms

    const slotStart =
      selectedSlot?.start ??
      (() => {
        const now = new Date()
        const anchor = new Date(date)
        anchor.setHours(now.getHours(), now.getMinutes() < 30 ? 0 : 30, 0, 0)
        return anchor
      })()
    const slotEnd =
      selectedSlot?.end ?? new Date(slotStart.getTime() + 30 * 60_000)
    return rooms.filter((room) =>
      room.bookings.every(
        (booking) =>
          !['confirmed', 'pending'].includes(booking.status) ||
          new Date(booking.start) >= slotEnd ||
          new Date(booking.end) <= slotStart
      )
    )
  }, [data?.results, date, onlyAvailable, selectedSlot])

  const outsideBookingCount = useMemo(
    () =>
      visibleRooms.reduce(
        (count, room) =>
          count +
          room.bookings.filter((booking) =>
            isOutsideWorkingHours(
              new Date(booking.start),
              new Date(booking.end),
              workingHours
            )
          ).length,
        0
      ),
    [visibleRooms, workingHours]
  )

  useEffect(() => {
    if (
      meetingRoomsTimeRangeMode === 'work' &&
      selectedSlot &&
      isOutsideWorkingHours(selectedSlot.start, selectedSlot.end, workingHours)
    ) {
      onClearSlot?.()
    }
  }, [meetingRoomsTimeRangeMode, onClearSlot, selectedSlot, workingHours])

  return (
    <div className={paneCls}>
      <div className={filterBarCls}>
        <MeetingRoomFilters value={filters} onChange={setFilters} />
        <button
          type="button"
          aria-pressed={onlyAvailable}
          className={onlyAvailable ? availabilityOnCls : availabilityOffCls}
          onClick={() => setOnlyAvailable((value) => !value)}
        >
          {t('filters.onlyAvailable')}
        </button>
        <div className={rangeActionsCls}>
          {meetingRoomsTimeRangeMode === 'work' && outsideBookingCount > 0 && (
            <button
              type="button"
              className={outsideButtonCls}
              onClick={() => setMeetingRoomsTimeRangeMode('full')}
            >
              {t('timeline.outsideBookings', { count: outsideBookingCount })}
            </button>
          )}
          <TimeRangeSwitcher
            value={meetingRoomsTimeRangeMode}
            onChange={setMeetingRoomsTimeRangeMode}
          />
          <span className={countCls}>
            {t('filters.roomCount', {
              visible: visibleRooms.length,
              total: data?.results.length ?? 0,
            })}
          </span>
        </div>
      </div>
      <div className={guideCls}>{t('timeline.guide')}</div>
      {isError ? (
        <div className={errorCls}>
          {t('pane.loadError')}
          <button
            type="button"
            className={retryCls}
            onClick={() => void refetch()}
          >
            {t('pane.retry')}
          </button>
        </div>
      ) : (
        <RoomTimeline
          rooms={visibleRooms}
          dayStart={visibleWindow.start}
          dayEnd={visibleWindow.end}
          workingHours={workingHours}
          timeRangeMode={meetingRoomsTimeRangeMode}
          isLoading={isFetching}
          emptyMessage={onlyAvailable ? t('picker.emptyAvailable') : undefined}
          selectedSlot={selectedSlot}
          onSelectSlot={onSelectSlot}
          onSlotChange={onSlotChange}
        />
      )}
    </div>
  )
}

const paneCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  height: '100%',
  minHeight: 0,
  padding: '0.75rem',
  overflow: 'hidden',
})
const filterBarCls = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.5rem',
})
const availabilityBase = {
  flexShrink: 0,
  paddingX: '0.625rem',
  paddingY: '0.375rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  cursor: 'pointer',
} as const
const availabilityOffCls = css({
  ...availabilityBase,
  border: '1px solid token(colors.greyscale.300)',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
})
const availabilityOnCls = css({
  ...availabilityBase,
  border: '1px solid token(colors.selected.accent)',
  backgroundColor: 'selected.bg',
  color: 'selected.text',
})
const countCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const rangeActionsCls = css({
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})
const outsideButtonCls = css({
  border: 'none',
  background: 'transparent',
  color: 'primary.600',
  fontSize: '0.75rem',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _dark: { color: 'primaryDark.700' },
})
const guideCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const errorCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '2rem',
  fontSize: '0.875rem',
  color: 'greyscale.600',
})
const retryCls = css({
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  fontSize: '0.875rem',
  cursor: 'pointer',
  _dark: { color: 'primaryDark.700' },
})
