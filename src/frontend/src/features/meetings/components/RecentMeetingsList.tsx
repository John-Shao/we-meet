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
import { RiMoreFill, RiVidiconLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'
import { Menu } from '@/primitives/Menu'
import { navigateTo } from '@/navigation/navigateTo'
import { useDeleteRoom } from '@/features/rooms/api/deleteRoom'
import { useConfirm } from '@/components/ConfirmProvider'

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
  const { confirm: askConfirm } = useConfirm()

  if (!enabled) return null
  if (isLoading) return null
  if (!data || data.length === 0) return null

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

  const handleDelete = async (id: string, label: string) => {
    if (
      !(await askConfirm({
        message: t('home.deleteConfirm', { name: label }),
        danger: true,
      }))
    ) {
      return
    }
    deleteRoom(id)
  }

  return (
    <div
      className={css({
        width: '100%',
        marginTop: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
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
          width: '100%',
          border: '1px solid',
          borderColor: 'greyscale.200',
          borderRadius: '10px',
          backgroundColor: 'white',
          overflow: 'hidden',
        })}
      >
        {visible.map((m) => {
          const label = m.name || t('home.untitled')
          return (
            <li
              key={m.id}
              className={css({
                '&:not(:last-child)': {
                  borderBottom: '1px solid token(colors.greyscale.100)',
                },
              })}
            >
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  _hover: { backgroundColor: 'greyscale.50' },
                })}
              >
                <button
                  type="button"
                  onClick={() => navigateTo('meetingDetail', m.id)}
                  className={css({
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    padding: '0.875rem 1rem',
                    cursor: 'pointer',
                  })}
                >
                  <span
                    className={css({
                      flexShrink: 0,
                      width: '40px',
                      height: '40px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '8px',
                      backgroundColor: 'primary.50',
                      color: 'primary.500',
                    })}
                  >
                    <RiVidiconLine size={20} />
                  </span>
                  <span className={css({ minWidth: 0, flex: 1 })}>
                    <span
                      className={css({
                        display: 'block',
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {label}
                    </span>
                    {m.summary_updated_at && (
                      <Text
                        className={css({
                          fontSize: '0.8rem',
                          color: 'greyscale.600',
                          marginTop: '0.125rem',
                        })}
                      >
                        {formatRelativeTime(m.summary_updated_at, i18n.language)}
                      </Text>
                    )}
                  </span>
                </button>
                <div
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    paddingRight: '0.75rem',
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
                        color: 'greyscale.600',
                        borderRadius: '4px',
                        _hover: { backgroundColor: 'greyscale.200' },
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
