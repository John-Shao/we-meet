/**
 * "My recent meetings" — appears on the home page after sign-in.
 *
 * Lists meetings (Rooms) the user joined that have a Summary, newest
 * first. Hidden on the logged-out home; renders nothing (not a
 * placeholder) when the list is empty so brand-new users don't see an
 * empty section.
 *
 * P8(对标飞书):行本身只负责「选中」—— 点击经 [onSelect] 打开右侧
 * 会议详情面板,进入会议 / 查看纪要 / 删除等操作全部收进面板
 * (MeetingDetailPanel);行内不再放按钮与 ⋮ 菜单。
 */

import { useState } from 'react'

import { useTranslation } from 'react-i18next'
import { RiVidiconLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { H, Text } from '@/primitives'

import { useRecentMeetings } from '../api/fetchMeeting'
import type { MeetingSelection } from './MeetingDetailPanel'

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

export const RecentMeetingsList = ({
  enabled,
  showEmpty = false,
  onSelect,
  selectedId,
}: {
  enabled: boolean
  /** 会议主区常驻:无历史时渲染「暂无历史会议」空态(企微式);落地页不传。 */
  showEmpty?: boolean
  /** P8:点行打开右侧详情面板。 */
  onSelect: (selection: MeetingSelection) => void
  /** 当前详情面板展示的会议 id → 行高亮。 */
  selectedId?: string | null
}) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading } = useRecentMeetings(enabled)
  const [expanded, setExpanded] = useState(false)

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
          {t('home.recentTitle')}
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
          {t('home.recentEmpty')}
        </div>
      </div>
    )
  }

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

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
          borderRadius: '8px',
          backgroundColor: 'greyscale.000',
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
              <button
                type="button"
                data-testid={`recent-row-${m.id}`}
                onClick={() =>
                  onSelect({
                    kind: 'recent',
                    id: m.id,
                    name: m.name,
                    slug: m.slug,
                    timeIso: m.summary_updated_at,
                  })
                }
                className={cx(
                  css({
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    padding: '0.875rem 1rem',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.50' },
                  }),
                  selectedId === m.id &&
                    css({ backgroundColor: 'greyscale.100' })
                )}
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
