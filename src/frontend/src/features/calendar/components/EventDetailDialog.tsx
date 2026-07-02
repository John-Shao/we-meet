import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { Modal } from '@/components/Modal'

import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'

interface Props {
  event: CalendarEvent
  onRsvp: (status: RSVPStatus) => void
  onJoin: () => void
  onClose: () => void
  /** Organizer-only: enables the 编辑 / 删除 actions. */
  canManage?: boolean
  onEdit?: () => void
  onDelete?: () => void
}

/**
 * Event detail popup opened by clicking a grid event (对标飞书). Carries the
 * RSVP (接受/待定/拒绝) + 进入会议 actions the agenda used to show inline, so the
 * grid keeps full functionality.
 */
export const EventDetailDialog = ({
  event,
  onRsvp,
  onJoin,
  onClose,
  canManage,
  onEdit,
  onDelete,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')
  const [rsvp, setRsvp] = useState<RSVPStatus | null>(event.my_rsvp ?? null)

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
  const sameDay =
    new Date(event.start_at).toDateString() ===
    new Date(event.end_at).toDateString()
  const when = event.all_day
    ? new Date(event.start_at).toLocaleDateString(i18n.language, {
        dateStyle: 'medium',
        timeZone: event.timezone || undefined,
      })
    : `${fmt(event.start_at)} – ${sameDay ? fmtTime(event.end_at) : fmt(event.end_at)}`

  const handle = (status: RSVPStatus) => {
    setRsvp(status)
    onRsvp(status)
  }

  return (
    <Modal onClose={onClose} ariaLabel={event.title} maxWidth="420px">
      <div className={css({ padding: '1.25rem' })}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1.125rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {event.title}
        </h2>
        <p
          className={css({
            margin: '0.5rem 0 0',
            fontSize: '0.875rem',
            color: 'greyscale.700',
          })}
        >
          {when}
        </p>
        <p
          className={css({
            margin: '0.25rem 0 0',
            fontSize: '0.75rem',
            color: 'greyscale.500',
          })}
        >
          {t('card.organizer')}: {event.organizer?.full_name || '—'} ·{' '}
          {t('card.attendees', {
            count: event.attendees.filter((a) => a.role !== 'organizer').length,
          })}
        </p>
        {event.description && (
          <p
            className={css({
              margin: '0.75rem 0 0',
              fontSize: '0.8125rem',
              color: 'greyscale.700',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            })}
          >
            {event.description}
          </p>
        )}
        {event.reminders && event.reminders.length > 0 && (
          <p
            className={css({
              margin: '0.5rem 0 0',
              fontSize: '0.75rem',
              color: 'greyscale.500',
            })}
          >
            🔔 {t('card.reminder')}:{' '}
            {event.reminders
              .map((m) => t('form.reminderMinutes', { count: m }))
              .join('、')}
          </p>
        )}

        {/* RSVP */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.375rem',
            marginTop: '1rem',
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
            (status) => (
              <button
                key={status}
                type="button"
                onClick={() => handle(status)}
                data-testid={`detail-rsvp-${status}`}
                className={cx(
                  css({
                    paddingX: '0.625rem',
                    paddingY: '0.25rem',
                    borderRadius: '999px',
                    border: '1px solid token(colors.greyscale.300)',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    backgroundColor: 'greyscale.000',
                    color: 'greyscale.700',
                  }),
                  rsvp === status
                    ? css({
                        backgroundColor: 'primary.500',
                        color: 'white',
                        borderColor: 'primary.500',
                      })
                    : undefined
                )}
              >
                {t(`rsvp.${status}`)}
              </button>
            )
          )}
        </div>

        {/* Actions: 编辑/删除(organizer)靠左,进入会议靠右 */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginTop: '1.25rem',
          })}
        >
          {canManage && (
            <>
              <button
                type="button"
                onClick={onEdit}
                data-testid="detail-edit"
                className={detailBtn}
              >
                {t('detail.edit')}
              </button>
              <button
                type="button"
                onClick={onDelete}
                data-testid="detail-delete"
                className={cx(
                  detailBtn,
                  css({ color: '#dc2626', borderColor: '#fecaca' })
                )}
              >
                {t('detail.delete')}
              </button>
            </>
          )}
          {event.room_slug && (
            <button
              type="button"
              onClick={onJoin}
              data-testid="detail-join"
              className={css({
                marginLeft: 'auto',
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
              {t('card.join')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

const detailBtn = css({
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
