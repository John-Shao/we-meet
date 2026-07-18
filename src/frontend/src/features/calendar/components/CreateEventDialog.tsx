import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
import { useDirectoryMemberSearch, MemberAvatar } from '@/features/contacts'

import { createCalendarEvent, updateCalendarEvent } from '../api/fetchCalendar'
import type { CalendarEvent } from '../api/ApiCalendar'

interface Props {
  onCreated: (event: CalendarEvent) => void
  onClose: () => void
  /** Prefill when opened from a grid slot click (飞书式快捷创建). Falls back
   * to "next full hour, 1h long" when omitted (top-bar 新建日程). */
  initialStart?: Date
  initialEnd?: Date
  initialAllDay?: boolean
  /** When set, the dialog edits this event (PATCH) instead of creating one.
   * Scalar fields only — attendees aren't editable (backend doesn't re-sync). */
  editEvent?: CalendarEvent
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Date → "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> (local time). */
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
/** "YYYY-MM-DDTHH:MM" → its date portion "YYYY-MM-DD" (for <input type="date">). */
const dateOnly = (v: string) => v.slice(0, 10)

const defaultStart = () => {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}

export const CreateEventDialog = ({
  onCreated,
  onClose,
  initialStart,
  initialEnd,
  initialAllDay,
  editEvent,
}: Props) => {
  const { t } = useTranslation('calendar')
  const isEdit = !!editEvent
  const start0 = editEvent
    ? new Date(editEvent.start_at)
    : (initialStart ?? defaultStart())
  const end0 = editEvent
    ? new Date(editEvent.end_at)
    : (initialEnd ?? new Date(start0.getTime() + 60 * 60 * 1000))

  const [title, setTitle] = useState(editEvent?.title ?? '')
  const [description, setDescription] = useState(editEvent?.description ?? '')
  const [start, setStart] = useState(toLocalInput(start0))
  const [end, setEnd] = useState(toLocalInput(end0))
  const [allDay, setAllDay] = useState(editEvent?.all_day ?? initialAllDay ?? false)
  // Reminders are a set of minutes-before (multi). Editing preserves ALL of the
  // event's existing reminders instead of collapsing to the first one.
  const [reminders, setReminders] = useState<Set<number>>(
    () => (editEvent ? new Set(editEvent.reminders ?? []) : new Set([10]))
  )
  // Preset choices + any non-preset value the event already carries (so an
  // externally-set reminder stays visible + toggleable, never silently dropped).
  const reminderOptions = useMemo(() => {
    const presets = [10, 30, 60]
    const extra = (editEvent?.reminders ?? []).filter((r) => !presets.includes(r))
    return [...new Set([...presets, ...extra])].sort((a, b) => a - b)
  }, [editEvent])
  const toggleReminder = (minutes: number) =>
    setReminders((prev) => {
      const next = new Set(prev)
      if (next.has(minutes)) next.delete(minutes)
      else next.add(minutes)
      return next
    })
  // P2-M1 重复日程:创建时可选预设;编辑重复规则属 M2 三选语义,编辑态不展示。
  const [repeat, setRepeat] = useState('')
  const [repeatUntil, setRepeatUntil] = useState('')
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()
  const { alert: showAlert } = useConfirm()

  const toggle = (id: string, label: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const canCreate = !!title.trim() && !!start && !!end && !busy

  // RRULE 组装:UNTIL 用「浮动本地时刻」(无 Z 后缀)——与后端按事件时区的
  // 墙上钟展开一致,且 dateutil 在 naive dtstart 下拒绝 UTC(Z)形式的 UNTIL。
  const composeRRule = () => {
    if (!repeat) return ''
    let rule =
      repeat === 'WEEKDAYS'
        ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
        : `FREQ=${repeat}`
    if (repeatUntil) rule += `;UNTIL=${repeatUntil.replace(/-/g, '')}T235959`
    return rule
  }

  const submit = async () => {
    if (!canCreate) return
    let startDate: Date
    let endDate: Date
    if (allDay) {
      // All-day: pin to local midnight and make the end the exclusive
      // next-midnight of the chosen end day, so a single-day all-day event
      // still spans a full 24h instead of the arbitrary picker time-of-day.
      startDate = new Date(`${dateOnly(start)}T00:00`)
      endDate = new Date(`${dateOnly(end)}T00:00`)
      endDate.setDate(endDate.getDate() + 1)
    } else {
      startDate = new Date(start)
      endDate = new Date(end)
    }
    if (endDate <= startDate) {
      void showAlert({ message: t('form.endAfterStart') })
      return
    }
    setBusy(true)
    try {
      const base = {
        title: title.trim(),
        description: description.trim(),
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
        all_day: allDay,
        reminders: [...reminders].sort((a, b) => a - b),
      }
      const event = editEvent
        ? await updateCalendarEvent(editEvent.id, base)
        : await createCalendarEvent({
            ...base,
            attendee_ids: [...selected.keys()],
            recurrence: composeRRule(),
          })
      onCreated(event)
    } catch (e) {
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('form.title')}
      initialFocusRef={titleRef}
      maxWidth="560px"
      maxHeight="82vh"
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
          {isEdit ? t('form.editTitle') : t('form.title')}
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

        <textarea
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('form.descriptionPlaceholder')}
          rows={3}
          data-testid="event-description"
          className={textareaCls}
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
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? dateOnly(start) : start}
              onChange={(e) => {
                const v = e.target.value
                setStart(allDay ? (v ? `${v}T00:00` : '') : v)
              }}
              data-testid="event-start"
              className={inputCls}
            />
          </label>
          <label className={fieldCls}>
            <span className={labelCls}>{t('form.end')}</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? dateOnly(end) : end}
              onChange={(e) => {
                const v = e.target.value
                setEnd(allDay ? (v ? `${v}T00:00` : '') : v)
              }}
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
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              fontSize: '0.875rem',
              color: 'greyscale.800',
            })}
          >
            <span>{t('form.reminder')}</span>
            {reminderOptions.map((m) => (
              <label
                key={m}
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                })}
              >
                <input
                  type="checkbox"
                  checked={reminders.has(m)}
                  onChange={() => toggleReminder(m)}
                />
                {t('form.reminderMinutes', { count: m })}
              </label>
            ))}
            {reminders.size === 0 && (
              <span className={css({ color: 'greyscale.500' })}>
                {t('form.reminderNone')}
              </span>
            )}
          </div>
        </div>

        {/* P2-M1 重复 — 创建时可选;编辑重复规则属 M2 三选语义,编辑态隐藏。 */}
        {!isEdit && (
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              fontSize: '0.875rem',
              color: 'greyscale.800',
            })}
          >
            <span>{t('form.repeat')}</span>
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              data-testid="event-repeat"
              className={inputCls}
            >
              <option value="">{t('form.repeatNone')}</option>
              <option value="DAILY">{t('form.repeatDaily')}</option>
              <option value="WEEKDAYS">{t('form.repeatWeekdays')}</option>
              <option value="WEEKLY">{t('form.repeatWeekly')}</option>
              <option value="MONTHLY">{t('form.repeatMonthly')}</option>
            </select>
            {repeat && (
              <label
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                })}
              >
                {t('form.repeatUntil')}
                <input
                  type="date"
                  value={repeatUntil}
                  onChange={(e) => setRepeatUntil(e.target.value)}
                  data-testid="event-repeat-until"
                  className={inputCls}
                />
              </label>
            )}
          </div>
        )}

        {/* Attendees — create-only; editing attendees isn't wired server-side. */}
        {!isEdit && (
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
                    aria-label={t('form.removeAttendee', { name: label })}
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
            ) : selectable.length === 0 ? (
              <p
                className={css({
                  padding: '0.75rem',
                  color: 'greyscale.500',
                  fontSize: '0.875rem',
                })}
              >
                {t('form.noResults')}
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
                    <MemberAvatar name={label} src={m.avatar_url} size="1.75rem" />
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
        )}
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
          {isEdit ? t('form.save') : t('form.create')}
        </button>
      </div>
    </Modal>
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
const textareaCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  outline: 'none',
  resize: 'vertical',
  minHeight: '3.5rem',
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
  backgroundColor: 'greyscale.000',
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
