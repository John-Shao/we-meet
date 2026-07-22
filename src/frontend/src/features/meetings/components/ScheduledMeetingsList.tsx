/**
 * "预约会议" — rooms with a future `scheduled_at` the user is a
 * member of. Sits above the recent-meetings list on Home; renders
 * nothing when empty so the page stays compact for users with no
 * upcoming meetings.
 *
 * P8(对标飞书):行本身只负责「选中」—— 点击经 [onSelect] 打开右侧
 * 会议详情面板,进入会议 / 复制 / 删除等操作全部收进面板
 * (MeetingDetailPanel);行内不再放按钮与 ⋮ 菜单。
 */

import { useState } from 'react'

import { useTranslation } from 'react-i18next'
import { RiCalendarLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'

import { useScheduledMeetings } from '../api/fetchMeeting'
import type { MeetingSelection } from './MeetingDetailPanel'

const COLLAPSED_COUNT = 5

/** 预约时间口径(与 App 端对齐):当天 →「今天 HH:mm」;否则「M月d日
 * HH:mm」(不带年,预约都是近期未来)。 */
const formatScheduledAt = (iso: string, locale: string, today: string) => {
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    const time = new Intl.DateTimeFormat(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
    if (sameDay) return `${today} ${time}`
    const monthDay = new Intl.DateTimeFormat(locale || undefined, {
      month: 'short',
      day: 'numeric',
    }).format(d)
    return `${monthDay} ${time}`
  } catch {
    return iso
  }
}

export const ScheduledMeetingsList = ({
  enabled,
  showEmpty = false,
  onSelect,
  selectedId,
}: {
  enabled: boolean
  /** 在会议主区常驻显示:无预约时渲染「暂无待开始的会议」空态卡(企微式);
   * 匿名落地页不传,保持页面紧凑(空时不渲染)。 */
  showEmpty?: boolean
  /** P8:点行打开右侧详情面板。 */
  onSelect: (selection: MeetingSelection) => void
  /** 当前详情面板展示的会议 id → 行高亮。 */
  selectedId?: string | null
}) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading } = useScheduledMeetings(enabled)
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
          return (
            <li
              key={m.id}
              className={css({
                '&:not(:last-child)': {
                  borderBottom: '1px solid token(colors.scheduledCard.border)',
                },
              })}
            >
              <button
                type="button"
                data-testid={`scheduled-row-${m.id}`}
                onClick={() =>
                  onSelect({
                    kind: 'scheduled',
                    id: m.id,
                    name: m.name,
                    slug: m.slug || null,
                    timeIso: m.scheduled_at ?? null,
                  })
                }
                className={
                  // 单 css() 内联条件:cx 叠加同属性原子类按样式表顺序取
                  // 胜,选中底色可能被基类盖掉(panda-cx-atomic-order-trap)。
                  css({
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    textAlign: 'left',
                    border: 'none',
                    backgroundColor:
                      selectedId === m.id
                        ? 'scheduledCard.hover'
                        : 'transparent',
                    padding: '0.875rem 1rem',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'scheduledCard.hover' },
                  })
                }
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
                      {formatScheduledAt(
                        m.scheduled_at,
                        i18n.language,
                        t('home.today')
                      )}
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
