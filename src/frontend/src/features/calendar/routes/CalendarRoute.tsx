import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { css } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useUser } from '@/features/auth'
import { useConfirm } from '@/components/ConfirmProvider'

import { fetchCalendarEvents, rsvpCalendarEvent } from '../api/fetchCalendar'
import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'
import { CreateEventDialog } from '../components/CreateEventDialog'
import { CalendarGrid } from '../components/CalendarGrid'
import { CalendarSidebar } from '../components/CalendarSidebar'
import { EventDetailDialog } from '../components/EventDetailDialog'

const EVENTS_KEY = ['calendar', 'events'] as const

export const CalendarRoute = () => {
  const { t } = useTranslation('calendar')
  const { user, isLoggedIn } = useUser()

  if (!isLoggedIn || !user) {
    return (
      <div className={css({ padding: '2rem', color: 'greyscale.700' })}>
        {t('page.authRequired')}
      </div>
    )
  }
  return <CalendarAuthenticated />
}

const CalendarAuthenticated = () => {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const { alert: showAlert } = useConfirm()
  const [creating, setCreating] = useState(false)
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null)
  const [date, setDate] = useState<Date>(() => new Date())

  const { data: events = [], isLoading } = useQuery({
    queryKey: EVENTS_KEY,
    queryFn: fetchCalendarEvents,
    staleTime: 30_000,
  })

  const setRsvp = async (event: CalendarEvent, status: RSVPStatus) => {
    try {
      await rsvpCalendarEvent(event.id, status)
      await qc.invalidateQueries({ queryKey: EVENTS_KEY })
    } catch (e) {
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
    }
  }

  return (
    <div className={css({ display: 'flex', height: '100%' })}>
      {/* 二级导航栏:迷你日历 + 即将开始,与「视频会议」侧栏对齐。 */}
      <CalendarSidebar
        date={date}
        onDateChange={setDate}
        events={events}
        onSelectEvent={setDetailEvent}
      />

      <div
        className={css({
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: '1rem 1.25rem',
        })}
      >
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1rem',
          })}
        >
          <h1
            className={css({
              margin: 0,
              fontSize: '1.25rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('page.title')}
          </h1>
          <button
            type="button"
            onClick={() => setCreating(true)}
            data-testid="calendar-create"
            className={css({
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor: 'primary.500',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: 'pointer',
            })}
          >
            ＋ {t('page.create')}
          </button>
        </div>

        {/* 月/周/日 网格(react-big-calendar);点事件开详情弹窗(RSVP/进会)。 */}
        <div className={css({ flex: 1, minHeight: 0 })}>
          {isLoading ? (
            <p className={css({ color: 'greyscale.500' })}>
              {t('page.loading')}
            </p>
          ) : (
            <CalendarGrid
              events={events}
              onSelectEvent={setDetailEvent}
              date={date}
              onNavigate={setDate}
            />
          )}
        </div>
      </div>

      {detailEvent && (
        <EventDetailDialog
          event={detailEvent}
          onRsvp={(status) => setRsvp(detailEvent, status)}
          onJoin={() => {
            if (detailEvent.room_slug) navigate(`/${detailEvent.room_slug}`)
          }}
          onClose={() => setDetailEvent(null)}
        />
      )}

      {creating && (
        <CreateEventDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void qc.invalidateQueries({ queryKey: EVENTS_KEY })
          }}
        />
      )}
    </div>
  )
}
