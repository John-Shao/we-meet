import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { css } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useUser } from '@/features/auth'

import { fetchCalendarEvents, rsvpCalendarEvent } from '../api/fetchCalendar'
import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'
import { CreateEventDialog } from '../components/CreateEventDialog'

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
  const { t, i18n } = useTranslation('calendar')
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const [creating, setCreating] = useState(false)

  const { data: events = [], isLoading } = useQuery({
    queryKey: EVENTS_KEY,
    queryFn: fetchCalendarEvents,
    staleTime: 30_000,
  })

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, {
      hour: '2-digit',
      minute: '2-digit',
    })
  /** Start–end label; keeps the end date when the event spans multiple days. */
  const fmtRange = (startISO: string, endISO: string) => {
    const startDate = new Date(startISO)
    const endDate = new Date(endISO)
    const sameDay = startDate.toDateString() === endDate.toDateString()
    return `${fmt(startISO)} – ${sameDay ? fmtTime(endISO) : fmt(endISO)}`
  }
  /** All-day date, rendered in the event's own timezone to avoid a day shift. */
  const fmtAllDay = (iso: string, tz: string) => {
    try {
      return new Date(iso).toLocaleDateString(i18n.language, {
        dateStyle: 'medium',
        timeZone: tz || undefined,
      })
    } catch {
      // Defensive: an unexpected/invalid IANA name would make Intl throw.
      return new Date(iso).toLocaleDateString(i18n.language, {
        dateStyle: 'medium',
      })
    }
  }

  const setRsvp = async (event: CalendarEvent, status: RSVPStatus) => {
    try {
      await rsvpCalendarEvent(event.id, status)
      await qc.invalidateQueries({ queryKey: EVENTS_KEY })
    } catch (e) {
      window.alert(t('form.error', { message: apiErrorMessage(e) }))
    }
  }

  return (
    <div
      className={css({
        maxWidth: '760px',
        margin: '0 auto',
        padding: '1.5rem 1rem',
        height: '100%',
        overflowY: 'auto',
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

      {isLoading ? (
        <p className={css({ color: 'greyscale.500' })}>{t('page.loading')}</p>
      ) : events.length === 0 ? (
        <p className={css({ color: 'greyscale.500' })}>{t('page.empty')}</p>
      ) : (
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          })}
        >
          {events.map((event) => (
            <li
              key={event.id}
              data-testid={`calendar-event-${event.id}`}
              className={css({
                border: '1px solid token(colors.greyscale.200)',
                borderRadius: '0.75rem',
                padding: '0.875rem 1rem',
                backgroundColor: 'white',
              })}
            >
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                })}
              >
                <div className={css({ minWidth: 0 })}>
                  <div
                    className={css({
                      fontWeight: 'bold',
                      color: 'greyscale.900',
                    })}
                  >
                    {event.title}
                  </div>
                  <div
                    className={css({
                      fontSize: '0.8125rem',
                      color: 'greyscale.600',
                      marginTop: '0.125rem',
                    })}
                  >
                    {event.all_day
                      ? fmtAllDay(event.start_at, event.timezone)
                      : fmtRange(event.start_at, event.end_at)}
                  </div>
                  <div
                    className={css({
                      fontSize: '0.75rem',
                      color: 'greyscale.500',
                      marginTop: '0.25rem',
                    })}
                  >
                    {t('card.organizer')}: {event.organizer?.full_name || '—'} ·{' '}
                    {t('card.attendees', {
                      count: event.attendees.filter(
                        (a) => a.role !== 'organizer'
                      ).length,
                    })}
                  </div>
                </div>
                {event.room_slug && (
                  <button
                    type="button"
                    onClick={() => navigate(`/${event.room_slug}`)}
                    data-testid={`calendar-join-${event.id}`}
                    className={css({
                      flexShrink: 0,
                      border: '1px solid token(colors.primary.300)',
                      borderRadius: '0.5rem',
                      backgroundColor: 'white',
                      paddingX: '0.75rem',
                      paddingY: '0.375rem',
                      fontSize: '0.8125rem',
                      color: 'primary.600',
                      cursor: 'pointer',
                      _hover: { backgroundColor: 'primary.50' },
                    })}
                  >
                    {t('card.join')}
                  </button>
                )}
              </div>

              {/* RSVP */}
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  marginTop: '0.625rem',
                })}
              >
                <span
                  className={css({
                    fontSize: '0.75rem',
                    color: 'greyscale.500',
                    marginRight: '0.25rem',
                  })}
                >
                  {t('rsvp.label')}:
                </span>
                {(['accepted', 'tentative', 'declined'] as RSVPStatus[]).map(
                  (status) => {
                    const active = event.my_rsvp === status
                    return (
                      <button
                        key={status}
                        type="button"
                        onClick={() => setRsvp(event, status)}
                        data-testid={`calendar-rsvp-${status}-${event.id}`}
                        className={css({
                          paddingX: '0.625rem',
                          paddingY: '0.25rem',
                          borderRadius: '999px',
                          border: '1px solid token(colors.greyscale.300)',
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                          backgroundColor: active ? 'primary.500' : 'white',
                          color: active ? 'white' : 'greyscale.700',
                        })}
                      >
                        {t(`rsvp.${status}`)}
                      </button>
                    )
                  }
                )}
              </div>
            </li>
          ))}
        </ul>
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
