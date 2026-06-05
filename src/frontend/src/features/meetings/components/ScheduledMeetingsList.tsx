/**
 * "预约会议" — rooms with a future `scheduled_at` the user is a
 * member of. Sits above the recent-meetings list on Home; renders
 * nothing when empty so the page stays compact for users with no
 * upcoming meetings.
 *
 * Each card shows the meeting name + the scheduled time. Clicking
 * navigates straight to the room (PreviewScreen), not the meeting
 * detail — the meeting hasn't happened yet, so there's no detail to
 * view. The ⋮ menu offers a "delete" action that hits the same
 * DELETE endpoint the history list uses (see RecentMeetingsList for
 * the owner-vs-not semantics).
 */

import { useState } from 'react'

import { useTranslation } from 'react-i18next'
import { Button as RACButton, Menu as RACMenu, MenuItem } from 'react-aria-components'
import { RiMoreFill } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'
import { Menu } from '@/primitives/Menu'
import { navigateTo } from '@/navigation/navigateTo'
import { useDeleteRoom } from '@/features/rooms/api/deleteRoom'

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
  const { mutate: deleteRoom } = useDeleteRoom()

  if (!enabled) return null
  if (isLoading) return null
  if (!data || data.length === 0) return null

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

  const handleDelete = (idOrSlug: string, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(t('home.deleteConfirm', { name: label }))) {
      return
    }
    deleteRoom(idOrSlug)
  }

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
        {visible.map((m) => {
          const label = m.name || t('home.untitled')
          // Prefer the slug as the DELETE path slot — same as App side,
          // and avoids ambiguity when m.id is the canonical UUID but
          // the user is more used to the meeting code.
          const idOrSlug = m.slug || m.id
          return (
            <li key={m.id}>
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'stretch',
                  border: '1px solid',
                  borderColor: 'primary.300',
                  borderRadius: '6px',
                  backgroundColor: 'primary.50',
                  _hover: { backgroundColor: 'primary.100' },
                })}
              >
                <button
                  type="button"
                  onClick={() => navigateTo('room', m.slug)}
                  className={css({
                    flex: 1,
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    padding: '0.75rem 1rem',
                    cursor: 'pointer',
                  })}
                >
                  <div className={css({ fontWeight: 500 })}>{label}</div>
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
                <div
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    paddingRight: '0.5rem',
                  })}
                >
                  <Menu>
                    <RACButton
                      aria-label={t('home.rowMore')}
                      className={css({
                        background: 'transparent',
                        border: 'none',
                        padding: '0.25rem',
                        cursor: 'pointer',
                        color: 'primary.700',
                        borderRadius: '4px',
                        _hover: { backgroundColor: 'primary.200' },
                      })}
                    >
                      <RiMoreFill size={18} />
                    </RACButton>
                    <RACMenu>
                      <MenuItem
                        onAction={() => handleDelete(idOrSlug, label)}
                        className={css({
                          padding: '0.5rem 0.75rem',
                          cursor: 'pointer',
                          color: 'danger.700',
                          outline: 'none',
                          _hover: { backgroundColor: 'danger.50' },
                        })}
                      >
                        {t('home.delete')}
                      </MenuItem>
                    </RACMenu>
                  </Menu>
                </div>
              </div>
            </li>
          )
        })}
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
