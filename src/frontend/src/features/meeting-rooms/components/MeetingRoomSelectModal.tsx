import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives/Button'
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
import { roomIdentifier } from '../utils/roomLabel'
import { MeetingRoomFilters } from './MeetingRoomFilters'
import { MeetingRoomSummary } from './MeetingRoomSummary'

type Tab = 'available' | 'all'

const briefOf = (room: MeetingRoom): MeetingRoomBrief => ({
  id: room.id,
  name: room.name,
  code: room.code,
  floor: room.floor,
  capacity: room.capacity,
  node: room.node,
  path_label: room.path_label,
  timezone: room.timezone,
})

/** Stable query key for a facility set, independent of selection order. */
const facilityKey = (ids?: string[]) => (ids ?? []).slice().sort().join(',')

/** Mount when opened; only confirmation commits the local selection. */
export const MeetingRoomSelectModal = ({
  value,
  start,
  end,
  timezone,
  attendeeCount,
  excludeEventId,
  onConfirm,
  onClose,
}: {
  value: MeetingRoomBrief | null
  start: Date
  end: Date
  timezone?: string
  attendeeCount: number
  excludeEventId?: string
  onConfirm: (room: MeetingRoomBrief) => void
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('meeting-rooms')
  const searchRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState(value)
  const [tab, setTab] = useState<Tab>('available')
  const [filters, setFilters] = useState<RoomFilters>({})
  const [query, setQuery] = useState('')

  const effective: RoomFilters = { ...filters, q: query }
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const {
    data: availability = [],
    isFetching: loadingAvailability,
    isError: availabilityError,
    refetch: retryAvailability,
  } = useQuery({
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
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  })

  const {
    data: allRooms,
    isFetching: loadingAll,
    isError: allRoomsError,
    refetch: retryAll,
  } = useQuery({
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

  // Validate the draft independently of search/filter results. Filtering a
  // selected room out of the list must not discard or invalidate it.
  const {
    data: selectionAvailability = [],
    isFetching: checkingSelection,
    isError: selectionError,
    refetch: retrySelection,
  } = useQuery({
    queryKey: [
      'meeting-rooms',
      'availability',
      'selection',
      startIso,
      endIso,
      excludeEventId ?? '',
    ],
    queryFn: () =>
      fetchMeetingRoomAvailability(startIso, endIso, {}, { excludeEventId }),
    enabled: !!selected,
    staleTime: 15_000,
    refetchOnMount: 'always',
  })
  const selectedAvailable = selectionAvailability.some(
    (room) => room.id === selected?.id && room.is_available
  )
  const canConfirm =
    !!selected && selectedAvailable && !checkingSelection && !selectionError
  const formatter = new Intl.DateTimeFormat(
    i18n.resolvedLanguage || i18n.language,
    {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }
  )
  const slotLabel = `${formatter.format(start)} – ${formatter.format(end)} · ${formatter.resolvedOptions().timeZone}`

  const freeIds = availableIdSet(availability)
  const rows: MeetingRoom[] =
    tab === 'available'
      ? availability.filter((r) => r.is_available)
      : (allRooms?.results ?? [])
  const loading = loadingAvailability || (tab === 'all' && loadingAll)
  const loadError = availabilityError || (tab === 'all' && allRoomsError)

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('picker.title')}
      maxWidth="680px"
      maxHeight="85dvh"
      initialFocusRef={searchRef}
    >
      <ModalHeader
        title={t('picker.title')}
        onClose={onClose}
        closeLabel={t('picker.cancel')}
      />
      <ModalBody>
        <div className={panelCls} data-testid="mr-picker">
          <div className={slotCls} data-testid="mr-picker-slot">
            {slotLabel}
          </div>
          <div className={tabRowCls}>
            {(['available', 'all'] as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
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
            ref={searchRef}
            type="search"
            className={inputCls}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('picker.searchPlaceholder')}
            aria-label={t('picker.searchPlaceholder')}
            data-testid="mr-picker-search"
          />

          <MeetingRoomFilters value={filters} onChange={setFilters} compact />

          {attendeeCount > 0 && (
            <div className={hintCls}>
              {t('picker.capacityHint', { count: attendeeCount })}
            </div>
          )}

          <div className={listCls} aria-busy={loading}>
            {loadError ? (
              <div role="alert" className={emptyCls}>
                {t('pane.loadError')}
                <Button
                  variant="tertiary"
                  onPress={() => {
                    void retryAvailability()
                    if (tab === 'all') void retryAll()
                  }}
                >
                  {t('pane.retry')}
                </Button>
              </div>
            ) : rows.length === 0 ? (
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
                    disabled={busy || loading}
                    aria-pressed={selected?.id === room.id}
                    onClick={() => setSelected(briefOf(room))}
                    data-testid={`mr-picker-item-${room.id}`}
                    className={
                      busy
                        ? rowBusyCls
                        : selected?.id === room.id
                          ? rowSelectedCls
                          : rowCls
                    }
                  >
                    <MeetingRoomSummary
                      room={room}
                      primaryClassName={nameCls}
                      secondaryClassName={metaCls}
                    />
                    {busy && (
                      <span className={metaCls}>{t('picker.unavailable')}</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter className={footerCls}>
        <div className={selectionCls} aria-live="polite">
          <span>
            {selected
              ? t('picker.selected', { name: roomIdentifier(selected) })
              : t('picker.selectHint')}
          </span>
          {selected &&
            !checkingSelection &&
            !selectionError &&
            !selectedAvailable && (
              <span className={errorCls}>{t('picker.unavailable')}</span>
            )}
          {selected && checkingSelection && <span>{t('pane.loading')}</span>}
          {selectionError && (
            <span role="alert">
              {t('pane.loadError')}{' '}
              <Button
                variant="tertiary"
                onPress={() => {
                  void retrySelection()
                }}
              >
                {t('pane.retry')}
              </Button>
            </span>
          )}
        </div>
        <div className={actionsCls}>
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('picker.cancel')}
          </Button>
          <Button
            variant="primary"
            size="action"
            isDisabled={!canConfirm}
            onPress={() => {
              if (canConfirm && selected) onConfirm(selected)
            }}
            data-testid="mr-picker-confirm"
          >
            {t('picker.confirm')}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}

const panelCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
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
  minHeight: '12rem',
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
const rowSelectedCls = css({
  ...rowBase,
  cursor: 'pointer',
  backgroundColor: 'selected.bg',
  boxShadow: 'inset 0 0 0 1px token(colors.selected.accent)',
})
const slotCls = css({
  fontSize: '0.8125rem',
  color: 'text.secondary',
  padding: '0.625rem',
  backgroundColor: 'greyscale.50',
  borderRadius: '0.375rem',
})
const footerCls = css({ flexWrap: 'wrap' })
const actionsCls = css({
  display: 'flex',
  gap: 'sm',
  flexShrink: 0,
  marginLeft: 'auto',
})
const selectionCls = css({
  flex: '1 1 12rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.8125rem',
  color: 'text.secondary',
  overflowWrap: 'anywhere',
})
const errorCls = css({ color: 'danger.600' })
const nameCls = css({ fontSize: '0.875rem', color: 'greyscale.900' })
const metaCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
const hintCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
const emptyCls = css({
  padding: '0.75rem',
  fontSize: '0.8125rem',
  color: 'greyscale.500',
  textAlign: 'center',
})
