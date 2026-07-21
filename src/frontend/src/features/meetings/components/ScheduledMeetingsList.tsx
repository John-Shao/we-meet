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
import { RiMoreFill, RiCalendarLine, RiVidiconLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'
import { Menu } from '@/primitives/Menu'
import { navigateTo } from '@/navigation/navigateTo'
import { useDeleteRoom } from '@/features/rooms/api/deleteRoom'
import { useConfirm } from '@/components/ConfirmProvider'

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

export const ScheduledMeetingsList = ({
  enabled,
  showEmpty = false,
}: {
  enabled: boolean
  /** 在会议主区常驻显示:无预约时渲染「暂无待开始的会议」空态卡(企微式);
   * 匿名落地页不传,保持页面紧凑(空时不渲染)。 */
  showEmpty?: boolean
}) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading } = useScheduledMeetings(enabled)
  const [expanded, setExpanded] = useState(false)
  const { mutate: deleteRoom } = useDeleteRoom()
  const { confirm: askConfirm } = useConfirm()

  if (!enabled) return null
  if (isLoading) return null
  if (!data || data.length === 0) {
    if (!showEmpty) return null
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
          {t('home.scheduledTitle')}
        </H>
        <div
          className={css({
            width: '100%',
            border: '1px solid',
            borderColor: 'greyscale.200',
            borderRadius: '8px',
            backgroundColor: 'greyscale.000',
            padding: '2.5rem 1rem',
            textAlign: 'center',
            color: 'greyscale.500',
            fontSize: '0.875rem',
          })}
        >
          {t('home.scheduledEmpty')}
        </div>
      </div>
    )
  }

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

  const handleDelete = async (idOrSlug: string, label: string) => {
    if (
      !(await askConfirm({
        message: t('home.deleteConfirm', { name: label }),
        danger: true,
      }))
    ) {
      return
    }
    deleteRoom(idOrSlug)
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
        {t('home.scheduledTitle')}
      </H>
      <ul
        className={css({
          listStyle: 'none',
          padding: 0,
          margin: 0,
          width: '100%',
          border: '1px solid',
          borderColor: 'scheduledCard.border',
          borderRadius: '8px',
          backgroundColor: 'scheduledCard.bg',
          overflow: 'hidden',
        })}
      >
        {visible.map((m) => {
          const label = m.name || t('home.untitled')
          // Prefer the slug as the DELETE path slot — same as App side,
          // and avoids ambiguity when m.id is the canonical UUID but
          // the user is more used to the meeting code.
          const idOrSlug = m.slug || m.id
          return (
            <li
              key={m.id}
              className={css({
                '&:not(:last-child)': {
                  borderBottom: '1px solid token(colors.scheduledCard.border)',
                },
              })}
            >
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  _hover: { backgroundColor: 'scheduledCard.hover' },
                })}
              >
                <button
                  type="button"
                  onClick={() => navigateTo('room', m.slug)}
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
                      backgroundColor: 'primary.500',
                      color: 'white',
                    })}
                  >
                    <RiCalendarLine size={20} />
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
                    {m.scheduled_at && (
                      <Text
                        className={css({
                          fontSize: '0.8rem',
                          color: 'scheduledCard.text',
                          marginTop: '0.125rem',
                        })}
                      >
                        {t('home.scheduledTimePrefix', {
                          time: formatScheduledAt(m.scheduled_at, i18n.language),
                        })}
                      </Text>
                    )}
                  </span>
                </button>
                <div
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    paddingRight: '0.75rem',
                  })}
                >
                  <button
                    type="button"
                    onClick={() => navigateTo('room', m.slug)}
                    className={css({
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      border: '1px solid token(colors.scheduledCard.border)',
                      borderRadius: '8px',
                      background: 'transparent',
                      color: 'scheduledCard.text',
                      paddingX: '0.625rem',
                      paddingY: '0.3125rem',
                      fontSize: '0.8125rem',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      _hover: { backgroundColor: 'scheduledCard.hover' },
                    })}
                  >
                    <RiVidiconLine size={16} />
                    {t('home.enterMeeting')}
                  </button>
                  <Menu>
                    <RACButton
                      aria-label={t('home.rowMore')}
                      className={css({
                        background: 'transparent',
                        border: 'none',
                        padding: '0.25rem',
                        cursor: 'pointer',
                        color: 'scheduledCard.text',
                        borderRadius: '6px',
                        _hover: { backgroundColor: 'scheduledCard.hover' },
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
            color: 'scheduledCard.text',
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
