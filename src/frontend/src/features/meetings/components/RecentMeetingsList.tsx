/**
 * "My recent meetings" — appears on the home page after sign-in.
 *
 * Lists meetings (Rooms) the user joined that have a Summary, newest
 * first. Each card links to /meetings/<uuid>. Hidden on the logged-out
 * home; renders nothing (not a placeholder) when the list is empty so
 * brand-new users don't see an empty section.
 *
 * Each card has a ⋮ menu with a "delete" option. The backend permits
 * DELETE only to the room owner — for non-owners the mutation 403s and
 * the optimistic refetch leaves the row in place; for owners the row
 * disappears once the scheduled-/recent-meetings queries refetch.
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

import { useRecentMeetings } from '../api/fetchMeeting'

// Show a short list by default; the backend already caps the feed at 20.
const COLLAPSED_COUNT = 5

const formatRelativeTime = (iso: string, locale: string) => {
  try {
    const date = new Date(iso)
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return iso
  }
}

export const RecentMeetingsList = ({ enabled }: { enabled: boolean }) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading } = useRecentMeetings(enabled)
  const [expanded, setExpanded] = useState(false)
  const { mutate: deleteRoom } = useDeleteRoom()

  if (!enabled) return null
  if (isLoading) return null
  if (!data || data.length === 0) return null

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

  const handleDelete = (id: string, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(t('home.deleteConfirm', { name: label }))) {
      return
    }
    deleteRoom(id)
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
        {t('home.recentTitle')}
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
          return (
            <li key={m.id}>
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'stretch',
                  border: '1px solid',
                  borderColor: 'gray.300',
                  borderRadius: '6px',
                  backgroundColor: 'white',
                  _hover: { backgroundColor: 'gray.100' },
                })}
              >
                <button
                  type="button"
                  onClick={() => navigateTo('meetingDetail', m.id)}
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
                  {m.summary_updated_at && (
                    <Text
                      className={css({
                        fontSize: '0.8rem',
                        color: 'gray.600',
                        marginTop: '0.125rem',
                      })}
                    >
                      {formatRelativeTime(m.summary_updated_at, i18n.language)}
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
                        color: 'gray.600',
                        borderRadius: '4px',
                        _hover: { backgroundColor: 'gray.200' },
                      })}
                    >
                      <RiMoreFill size={18} />
                    </RACButton>
                    <RACMenu>
                      <MenuItem
                        onAction={() => handleDelete(m.id, label)}
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
