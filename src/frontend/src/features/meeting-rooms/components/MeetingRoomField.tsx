import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { linkBtnCls } from '@/styles/controls'
import { chipCls, labelCls } from '@/features/calendar/components/formStyles'

import type { MeetingRoomBrief } from '../api/ApiMeetingRoom'
import { fetchMeetingRoomAvailability } from '../api/fetchMeetingRooms'
import { selectionConflicts } from '../utils/roomAvailability'
import { roomIdentifier, roomScheduleLabel } from '../utils/roomLabel'
import { MeetingRoomPickerInline } from './MeetingRoomPickerInline'

/**
 * The 「添加会议室」 block in the event form (P9).
 *
 * Sits after the attendee block: the capacity filter is seeded from the number
 * of people invited, and availability depends on the time range chosen above,
 * so this reads last both visually and logically.
 *
 * Reports its own conflict state via `onConflictChange` so the dialog can
 * disable submit — but the server's 409 is still the authority; this only saves
 * a round-trip and explains the problem in place.
 */
export const MeetingRoomField = ({
  value,
  onChange,
  start,
  end,
  allDay,
  attendeeCount,
  excludeEventId,
  onConflictChange,
}: {
  value: MeetingRoomBrief | null
  onChange: (room: MeetingRoomBrief | null) => void
  start: Date | null
  end: Date | null
  allDay: boolean
  attendeeCount: number
  excludeEventId?: string
  onConflictChange?: (conflicted: boolean) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const [open, setOpen] = useState(false)

  const canQuery = !allDay && !!start && !!end && end > start
  const startIso = canQuery ? start.toISOString() : ''
  const endIso = canQuery ? end.toISOString() : ''

  const { data: availability = [], isFetching } = useQuery({
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
    enabled: canQuery && !!value,
    staleTime: 15_000,
  })

  // While the check is in flight we report "no conflict": flickering the
  // submit button off and back on is worse than a late, accurate 409.
  const conflicted =
    !allDay && !isFetching && selectionConflicts(value?.id, availability)

  useEffect(() => {
    onConflictChange?.(conflicted)
    // The callback is recreated every render by most parents; keying the effect
    // on it would fire on every render instead of on real changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicted])

  // M1: an all-day event cannot hold a room (the server rejects it too) —
  // "which timezone's midnight-to-midnight" is a question we have not answered
  // yet. Same rule the free/busy bar already follows.
  if (allDay) {
    return (
      <div>
        <div className={labelCls}>{t('picker.label')}</div>
        <div className={mutedCls}>{t('picker.allDayUnsupported')}</div>
      </div>
    )
  }

  return (
    <div data-testid="event-meeting-room">
      <div className={headerCls}>
        <span className={labelCls}>{t('picker.label')}</span>
        {canQuery && (
          <button
            type="button"
            className={linkBtnCls}
            onClick={() => setOpen((prev) => !prev)}
            data-testid="mr-picker-toggle"
          >
            {open
              ? t('picker.collapse')
              : value
                ? t('picker.change')
                : t('picker.add')}
          </button>
        )}
      </div>

      {value ? (
        <div className={selectedRowCls} data-testid="mr-selected-chip">
          <span className={chipCls}>
            {roomScheduleLabel(
              value.node.name,
              value,
              t('unit.people', { count: value.capacity })
            )}
          </span>
          <button
            type="button"
            className={clearBtnCls}
            onClick={() => onChange(null)}
            aria-label={t('picker.clear')}
            data-testid="mr-clear"
          >
            ×
          </button>
        </div>
      ) : (
        !open && <div className={mutedCls}>{t('picker.none')}</div>
      )}

      {conflicted && value && (
        <div className={conflictCls} data-testid="mr-conflict-warning">
          {t('conflict.inline', { name: roomIdentifier(value) })}
          <button
            type="button"
            className={conflictActionCls}
            onClick={() => setOpen(true)}
          >
            {t('conflict.switchRoom')}
          </button>
          <button
            type="button"
            className={conflictActionCls}
            onClick={() => onChange(null)}
          >
            {t('conflict.clearBooking')}
          </button>
        </div>
      )}

      {open && canQuery && (
        <div className={css({ marginTop: '0.5rem' })}>
          <MeetingRoomPickerInline
            start={start}
            end={end}
            attendeeCount={attendeeCount}
            excludeEventId={excludeEventId}
            onPick={(room) => {
              onChange(room)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.25rem',
})
const selectedRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
})
const clearBtnCls = css({
  border: 'none',
  background: 'transparent',
  color: 'greyscale.500',
  fontSize: '1rem',
  lineHeight: 1,
  cursor: 'pointer',
})
const mutedCls = css({ fontSize: '0.8125rem', color: 'greyscale.500' })
const conflictCls = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.375rem',
  fontSize: '0.75rem',
  color: 'danger.600',
})
const conflictActionCls = css({
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  fontSize: '0.75rem',
  textDecoration: 'underline',
  cursor: 'pointer',
  _dark: { color: 'primaryDark.700' },
})
