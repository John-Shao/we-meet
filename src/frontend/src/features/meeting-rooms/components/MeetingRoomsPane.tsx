import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { RoomFilters } from '../api/ApiMeetingRoom'
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
  onSelectSlot,
}: {
  date: Date
  onSelectSlot?: (roomId: string, start: Date, end: Date) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const [filters, setFilters] = useState<RoomFilters>({})

  const { start: dayStart, end: dayEnd } = dayWindow(date)
  const startIso = dayStart.toISOString()
  const endIso = dayEnd.toISOString()

  const { data, isFetching, isError, refetch } = useQuery({
    /* eslint-disable @tanstack/query/exhaustive-deps */
    queryKey: [
      'meeting-rooms',
      'timeline',
      startIso,
      filters.node ?? '',
      filters.capacityMin ?? 0,
      (filters.facilityIds ?? []).slice().sort().join(','),
    ],
    /* eslint-enable @tanstack/query/exhaustive-deps */
    queryFn: () => fetchMeetingRoomTimeline(startIso, endIso, filters),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  })

  return (
    <div className={paneCls}>
      <MeetingRoomFilters value={filters} onChange={setFilters} />
      {isError ? (
        <div className={errorCls}>
          {t('pane.loadError')}
          <button type="button" className={retryCls} onClick={() => void refetch()}>
            {t('pane.retry')}
          </button>
        </div>
      ) : (
        <RoomTimeline
          rooms={data?.results ?? []}
          dayStart={dayStart}
          dayEnd={dayEnd}
          isLoading={isFetching}
          onSelectSlot={onSelectSlot}
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
  overflowY: 'auto',
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
