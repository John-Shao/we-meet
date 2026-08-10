import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { inputCls } from '@/features/calendar/components/formStyles'

import type {
  MeetingRoom,
  MeetingRoomBrief,
  RoomFilters,
} from '../api/ApiMeetingRoom'
import {
  fetchMeetingRoomAvailability,
  fetchMeetingRooms,
} from '../api/fetchMeetingRooms'
import { availableIdSet } from '../utils/roomAvailability'
import { compactRoomPathLabel } from '../utils/roomHierarchy'
import { MeetingRoomFilters } from './MeetingRoomFilters'

type Tab = 'available' | 'all'

const briefOf = (room: MeetingRoom): MeetingRoomBrief => ({
  id: room.id,
  name: room.name,
  code: room.code,
  capacity: room.capacity,
  node: room.node,
  path_label: room.path_label,
  timezone: room.timezone,
})

/** Stable query key for a facility set, independent of selection order. */
const facilityKey = (ids?: string[]) => (ids ?? []).slice().sort().join(',')

/**
 * The room list behind 「添加会议室」 — inline, not a nested modal.
 *
 * `Modal` installs a focus trap and an Escape handler; stacking two of them
 * makes the layers fight over focus. The attendee block right above this one is
 * already an inline search + inline list, so this matches the surrounding form.
 */
export const MeetingRoomPickerInline = ({
  start,
  end,
  attendeeCount,
  excludeEventId,
  onPick,
}: {
  start: Date
  end: Date
  /** Seeds the capacity filter — the room has to fit the people invited. */
  attendeeCount: number
  excludeEventId?: string
  onPick: (room: MeetingRoomBrief) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const [tab, setTab] = useState<Tab>('available')
  const [filters, setFilters] = useState<RoomFilters>({})
  const [query, setQuery] = useState('')

  const effective: RoomFilters = { ...filters, q: query }
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const { data: availability = [], isFetching: loadingAvailability } = useQuery(
    {
      /* eslint-disable @tanstack/query/exhaustive-deps */
      queryKey: [
        'meeting-rooms',
        'availability',
        startIso,
        endIso,
        filters.node ?? '',
        filters.capacityMin ?? 0,
        facilityKey(filters.facilityIds),
        query,
        excludeEventId ?? '',
      ],
      /* eslint-enable @tanstack/query/exhaustive-deps */
      queryFn: () =>
        fetchMeetingRoomAvailability(startIso, endIso, effective, {
          excludeEventId,
        }),
      staleTime: 15_000,
      placeholderData: keepPreviousData,
    }
  )

  const { data: allRooms, isFetching: loadingAll } = useQuery({
    /* eslint-disable @tanstack/query/exhaustive-deps */
    queryKey: [
      'meeting-rooms',
      'list',
      filters.node ?? '',
      filters.capacityMin ?? 0,
      facilityKey(filters.facilityIds),
      query,
    ],
    /* eslint-enable @tanstack/query/exhaustive-deps */
    queryFn: () => fetchMeetingRooms(effective),
    enabled: tab === 'all',
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  const freeIds = availableIdSet(availability)
  const rows: MeetingRoom[] =
    tab === 'available'
      ? availability.filter((r) => r.is_available)
      : (allRooms?.results ?? [])
  const loading = tab === 'available' ? loadingAvailability : loadingAll

  return (
    <div className={panelCls} data-testid="mr-picker">
      <div className={tabRowCls}>
        {(['available', 'all'] as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            data-testid={`mr-picker-tab-${key}`}
            className={tab === key ? tabActiveCls : tabIdleCls}
          >
            {key === 'available'
              ? t('picker.tabAvailable')
              : t('picker.tabAll')}
          </button>
        ))}
      </div>

      <input
        type="search"
        className={inputCls}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('picker.searchPlaceholder')}
        data-testid="mr-picker-search"
      />

      <MeetingRoomFilters value={filters} onChange={setFilters} compact />

      {attendeeCount > 0 && (
        <div className={hintCls}>
          {t('picker.capacityHint', { count: attendeeCount })}
        </div>
      )}

      <div className={listCls}>
        {rows.length === 0 ? (
          <div className={emptyCls}>
            {loading
              ? t('pane.loading')
              : tab === 'available'
                ? t('picker.emptyAvailable')
                : t('pane.empty')}
          </div>
        ) : (
          rows.map((room) => {
            // On the 「所有会议室」 tab, a room that is busy for this slot is
            // shown but not selectable: letting someone pick a room that is
            // guaranteed to 409 is pure frustration.
            const busy = tab === 'all' && !freeIds.has(room.id)
            return (
              <button
                key={room.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(briefOf(room))}
                data-testid={`mr-picker-item-${room.id}`}
                className={busy ? rowBusyCls : rowCls}
              >
                <span className={nameCls}>{room.name}</span>
                <span className={metaCls}>
                  {compactRoomPathLabel(room.path_label)}
                  {room.capacity > 0 &&
                    ` · ${t('unit.people', { count: room.capacity })}`}
                  {busy && ` · ${t('picker.unavailable')}`}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

const panelCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.625rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.50',
})
const tabRowCls = css({ display: 'flex', gap: '0.25rem' })
const tabBase = {
  paddingX: '0.75rem',
  paddingY: '0.3125rem',
  borderRadius: '0.375rem',
  border: 'none',
  fontSize: '0.8125rem',
  cursor: 'pointer',
} as const
const tabActiveCls = css({
  ...tabBase,
  backgroundColor: 'primary.500',
  color: 'white',
  _dark: { backgroundColor: 'primaryDark.500' },
})
const tabIdleCls = css({
  ...tabBase,
  backgroundColor: 'transparent',
  color: 'greyscale.600',
})
const listCls = css({
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '13rem',
  overflowY: 'auto',
  gap: '0.125rem',
})
const rowBase = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.125rem',
  paddingX: '0.5rem',
  paddingY: '0.375rem',
  border: 'none',
  borderRadius: '0.375rem',
  backgroundColor: 'transparent',
  textAlign: 'left',
  width: '100%',
} as const
const rowCls = css({
  ...rowBase,
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
const rowBusyCls = css({ ...rowBase, cursor: 'not-allowed', opacity: 0.5 })
const nameCls = css({ fontSize: '0.875rem', color: 'greyscale.900' })
const metaCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
const hintCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
const emptyCls = css({
  padding: '0.75rem',
  fontSize: '0.8125rem',
  color: 'greyscale.500',
  textAlign: 'center',
})
