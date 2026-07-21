import { useTranslation } from 'react-i18next'
import { RiCalendarTodoFill } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { reminderCountdown, reminderTimeRange } from '@/features/calendar'

import {
  useReminderEntryEnabled,
  useReminderWindow,
} from '../hooks/useReminderEntry'

/**
 * P8「在消息列表提醒日程」入口(对标飞书):当日存在未结束日程时,
 * 会话列表最上方一行 —— 橙色日历图标 + 最近日程名 + 倒计时角标
 * (「N 分钟后」/进行中「现在」)+ 时间段副行。点击进入日程提醒页。
 * 它是列表的一个元素(渲染在 aside 滚动容器内、ConversationList 之上),
 * 随列表一起滚动可被推出屏幕,并非固定置顶。开关关闭或今日无未结束
 * 日程 → 不渲染。
 */
export const ReminderEntry = ({
  active,
  onOpen,
}: {
  /** 日程提醒页当前打开 → 行高亮(与会话选中态一致)。 */
  active: boolean
  onOpen: () => void
}) => {
  const { t } = useTranslation('im')
  const [enabled] = useReminderEntryEnabled()
  const { nearest, now } = useReminderWindow(enabled)

  if (!enabled || !nearest) return null

  const countdown = reminderCountdown(nearest, now)
  const range = reminderTimeRange(nearest)

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="im-reminder-entry"
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '0.625rem',
        width: '100%',
        paddingX: '0.875rem',
        paddingY: '0.625rem',
        border: 'none',
        borderBottom: '1px solid token(colors.greyscale.100)',
        cursor: 'pointer',
        textAlign: 'left',
        backgroundColor: active ? 'greyscale.200' : 'transparent',
        _hover: { backgroundColor: active ? 'greyscale.200' : 'greyscale.100' },
      })}
    >
      <span
        aria-hidden="true"
        className={css({
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '2.5rem',
          height: '2.5rem',
          borderRadius: '0.5rem',
          backgroundColor: '#f80', // 飞书同款橙(日程提醒专属,不随主题)
          color: 'white',
        })}
      >
        <RiCalendarTodoFill size={22} />
      </span>
      <span
        className={css({
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.125rem',
        })}
      >
        <span
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
          })}
        >
          <span
            className={css({
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'greyscale.900',
              fontWeight: 'medium',
            })}
          >
            {nearest.title || t('reminder.title')}
          </span>
          {countdown && (
            <span
              className={css({
                flexShrink: 0,
                fontSize: '0.6875rem',
                paddingX: '0.375rem',
                paddingY: '0.0625rem',
                borderRadius: '0.25rem',
                backgroundColor: 'rgba(255,136,0,0.14)',
                color: '#d97706',
              })}
            >
              {countdown.kind === 'now'
                ? t('reminder.now')
                : t('reminder.inMinutes', { count: countdown.minutes })}
            </span>
          )}
        </span>
        <span
          className={css({
            fontSize: '0.75rem',
            color: 'greyscale.500',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          {range ?? t('calendar.card.allDay')}
        </span>
      </span>
    </button>
  )
}
