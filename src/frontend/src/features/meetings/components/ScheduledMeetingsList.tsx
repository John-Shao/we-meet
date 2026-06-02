/**
 * "预约会议" — rooms with a future `scheduled_at` the user is a
 * member of. Sits above the recent-meetings list on Home; renders
 * nothing when empty so the page stays compact for users with no
 * upcoming meetings.
 *
 * Each card shows the meeting name + the scheduled time. Clicking
 * navigates straight to the room (PreviewScreen), not the meeting
 * detail — the meeting hasn't happened yet, so there's no detail to
 * view.
 */

import { useState } from 'react'

import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'
import { navigateTo } from '@/navigation/navigateTo'

import { useScheduledMeetings } from '../api/fetchMeeting'

const COLLAPSED_COUNT = 5

const formatScheduledAt = (iso: string, locale: string) => {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export const ScheduledMeetingsList = ({ enabled }: { enabled: boolean }) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading } = useScheduledMeetings(enabled)
  const [expanded, setExpanded] = useState(false)

  if (!enabled) return null
  if (isLoading) return null
  if (!data || data.length === 0) return null

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

  return (
    <div
      className={css({
        width: '100%',
        maxWidth: '30rem',
        marginTop: '2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      })}
    >
      <H lvl={3} margin={false}>
        {t('home.scheduledTitle')}
      </H>
      <ul
        className={css({
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        })}
      >
        {visible.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => navigateTo('room', m.slug)}
              className={css({
                width: '100%',
                textAlign: 'left',
                border: '1px solid',
                borderColor: 'primary.300',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                backgroundColor: 'primary.50',
                cursor: 'pointer',
                transition: 'background-color 0.15s',
                _hover: { backgroundColor: 'primary.100' },
              })}
            >
              <div className={css({ fontWeight: 500 })}>
                {m.name || t('home.untitled')}
              </div>
              {m.scheduled_at && (
                <Text
                  className={css({
                    fontSize: '0.8rem',
                    color: 'primary.700',
                    marginTop: '0.125rem',
                  })}
                >
                  {t('home.scheduledTimePrefix', {
                    time: formatScheduledAt(m.scheduled_at, i18n.language),
                  })}
                </Text>
              )}
            </button>
          </li>
        ))}
      </ul>
      {canToggle && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={css({
            alignSelf: 'center',
            marginTop: '0.25rem',
            padding: '0.25rem 0.5rem',
            background: 'none',
            border: 'none',
            color: 'primary.700',
            fontSize: '0.85rem',
            cursor: 'pointer',
            _hover: { textDecoration: 'underline' },
          })}
        >
          {expanded
            ? t('home.collapse')
            : t('home.showAll', { count: data.length })}
        </button>
      )}
    </div>
  )
}
