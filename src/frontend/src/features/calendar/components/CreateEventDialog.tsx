import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { fetchDirectoryMembers } from '@/features/contacts'

import { createCalendarEvent } from '../api/fetchCalendar'
import type { CalendarEvent } from '../api/ApiCalendar'

interface Props {
  onCreated: (event: CalendarEvent) => void
  onClose: () => void
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Date → "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> (local time). */
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

const defaultStart = () => {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}

export const CreateEventDialog = ({ onCreated, onClose }: Props) => {
  const { t } = useTranslation('calendar')
  const start0 = defaultStart()
  const end0 = new Date(start0.getTime() + 60 * 60 * 1000)

  const [title, setTitle] = useState('')
  const [start, setStart] = useState(toLocalInput(start0))
  const [end, setEnd] = useState(toLocalInput(end0))
  const [allDay, setAllDay] = useState(false)
  const [reminder, setReminder] = useState('10') // minutes-before, '' = none
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data: members = [], isFetching } = useQuery({
    queryKey: ['directory', 'members', query],
    queryFn: () => fetchDirectoryMembers(query),
    staleTime: 30_000,
  })
  const selectable = members.filter((m) => !m.is_self)

  const toggle = (id: string, label: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const canCreate = !!title.trim() && !!start && !!end && !busy

  const submit = async () => {
    if (!canCreate) return
    const startISO = new Date(start).toISOString()
    const endISO = new Date(end).toISOString()
    if (new Date(endISO) <= new Date(startISO)) {
      window.alert(t('form.endAfterStart'))
      return
    }
    setBusy(true)
    try {
      const event = await createCalendarEvent({
        title: title.trim(),
        start_at: startISO,
        end_at: endISO,
        all_day: allDay,
        reminders: reminder ? [Number(reminder)] : [],
        attendee_ids: [...selected.keys()],
      })
      onCreated(event)
    } catch (e) {
      window.alert(
        t('form.error', { message: e instanceof Error ? e.message : String(e) })
      )
      setBusy(false)
    }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={css({
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        padding: '1rem',
      })}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('form.title')}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: '560px',
          maxHeight: '82vh',
          backgroundColor: 'white',
          borderRadius: '0.75rem',
          overflow: 'hidden',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
        })}
      >
        <div className={headerCls}>
          <h2
            className={css({
              margin: 0,
              fontSize: '1rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('form.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('form.cancel')}
            className={closeBtn}
          >
            ×
          </button>
        </div>

        <div
          className={css({
            overflowY: 'auto',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.875rem',
          })}
        >
          <input
            ref={titleRef}
            type="text"
            value={title}
            maxLength={255}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('form.titlePlaceholder')}
            data-testid="event-title"
            className={inputCls}
          />

          <div
            className={css({
              display: 'flex',
              gap: '0.75rem',
              flexWrap: 'wrap',
            })}
          >
            <label className={fieldCls}>
              <span className={labelCls}>{t('form.start')}</span>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                data-testid="event-start"
                className={inputCls}
              />
            </label>
            <label className={fieldCls}>
              <span className={labelCls}>{t('form.end')}</span>
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                data-testid="event-end"
                className={inputCls}
              />
            </label>
          </div>

          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
            })}
          >
            <label
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                fontSize: '0.875rem',
                color: 'greyscale.800',
                cursor: 'pointer',
              })}
            >
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              {t('form.allDay')}
            </label>
            <label
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                fontSize: '0.875rem',
                color: 'greyscale.800',
              })}
            >
              <span>{t('form.reminder')}</span>
              <select
                value={reminder}
                onChange={(e) => setReminder(e.target.value)}
                className={css({
                  paddingX: '0.5rem',
                  paddingY: '0.375rem',
                  border: '1px solid token(colors.greyscale.300)',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                })}
              >
                <option value="">{t('form.reminderNone')}</option>
                <option value="10">
                  {t('form.reminderMinutes', { count: 10 })}
                </option>
                <option value="30">
                  {t('form.reminderMinutes', { count: 30 })}
                </option>
                <option value="60">
                  {t('form.reminderMinutes', { count: 60 })}
                </option>
              </select>
            </label>
          </div>

          {/* Attendees */}
          <div>
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '0.375rem',
              })}
            >
              <span className={labelCls}>{t('form.attendees')}</span>
              <span
                className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
              >
                {t('form.selected', { count: selected.size })}
              </span>
            </div>
            {selected.size > 0 && (
              <ul
                className={css({
                  listStyle: 'none',
                  margin: '0 0 0.5rem',
                  padding: 0,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.375rem',
                })}
              >
                {[...selected.entries()].map(([id, label]) => (
                  <li key={id} className={chipCls}>
                    {label}
                    <button
                      type="button"
                      onClick={() => toggle(id, label)}
                      aria-label="remove"
                      className={css({
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'greyscale.500',
                        _hover: { color: '#dc2626' },
                      })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('form.searchPlaceholder')}
              data-testid="event-attendee-search"
              className={inputCls}
            />
            <div
              className={css({
                marginTop: '0.5rem',
                maxHeight: '180px',
                overflowY: 'auto',
                border: '1px solid token(colors.greyscale.200)',
                borderRadius: '0.5rem',
              })}
            >
              {isFetching && selectable.length === 0 ? (
                <p
                  className={css({
                    padding: '0.75rem',
                    color: 'greyscale.500',
                    fontSize: '0.875rem',
                  })}
                >
                  {t('form.loading')}
                </p>
              ) : (
                selectable.map((m) => {
                  const label = m.full_name || m.short_name || m.email || m.id
                  const checked = selected.has(m.id)
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggle(m.id, label)}
                      data-testid={`event-attendee-${m.id}`}
                      className={css({
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        width: '100%',
                        paddingX: '0.75rem',
                        paddingY: '0.5rem',
                        border: 'none',
                        borderBottom: '1px solid token(colors.greyscale.100)',
                        backgroundColor: checked
                          ? 'greyscale.100'
                          : 'transparent',
                        textAlign: 'left',
                        cursor: 'pointer',
                        _hover: { backgroundColor: 'greyscale.100' },
                      })}
                    >
                      <span
                        aria-hidden="true"
                        className={css({
                          flexShrink: 0,
                          width: '1.125rem',
                          height: '1.125rem',
                          borderRadius: '0.25rem',
                          border: '1px solid token(colors.greyscale.400)',
                          backgroundColor: checked ? 'primary.500' : 'white',
                          color: 'white',
                          fontSize: '0.75rem',
                          lineHeight: '1.125rem',
                          textAlign: 'center',
                        })}
                      >
                        {checked ? '✓' : ''}
                      </span>
                      <span
                        className={css({
                          minWidth: 0,
                          fontSize: '0.875rem',
                          color: 'greyscale.900',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        })}
                      >
                        {label}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>

        <div
          className={css({
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
            paddingX: '1rem',
            paddingY: '0.75rem',
            borderTop: '1px solid token(colors.greyscale.200)',
          })}
        >
          <button type="button" onClick={onClose} className={ghostBtn}>
            {t('form.cancel')}
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={submit}
            data-testid="event-create"
            className={css({
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor: canCreate ? 'primary.500' : 'greyscale.300',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: canCreate ? 'pointer' : 'not-allowed',
            })}
          >
            {t('form.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const closeBtn = css({
  border: 'none',
  background: 'transparent',
  fontSize: '1.25rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'greyscale.600',
})
const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})
const fieldCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  flex: 1,
  minWidth: '12rem',
})
const labelCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })
const ghostBtn = css({
  paddingX: '0.875rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'white',
  color: 'greyscale.700',
  fontSize: '0.875rem',
  cursor: 'pointer',
})
const chipCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.100',
  fontSize: '0.8125rem',
  color: 'greyscale.800',
})
