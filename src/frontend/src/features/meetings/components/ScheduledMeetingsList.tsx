import { useTranslation } from 'react-i18next'
import { RiAddLine, RiCalendarLine } from '@remixicon/react'

import { PageState } from '@/components/PageState'
import { css } from '@/styled-system/css'
import { Button, H, Text } from '@/primitives'

import { useVideoMeetings } from '../api/videoMeetings'
import type { MeetingSelection } from './MeetingDetailPanel'

/** 节标题 + 右侧动作。空态与有列表两条分支共用,保证动作任何时候都在。 */
const headerRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
})

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
  onSchedule,
}: {
  enabled: boolean
  /** 在会议主区常驻显示:无预约时渲染「暂无待开始的会议」空态卡(企微式);
   * 匿名落地页不传,保持页面紧凑(空时不渲染)。 */
  showEmpty?: boolean
  /** P8:点行打开右侧详情面板。 */
  onSelect: (selection: MeetingSelection) => void
  /** 当前详情面板展示的会议 id → 行高亮。 */
  selectedId?: string | null
  /**
   * 「预约会议」入口。原先在左侧导航列里,现收进本节标题右侧 —— 预约出来的
   * 会议就出现在这个列表里,入口和结果同处一节比隔着一条导航列更好找。
   * 放在标题行而不是空态卡里:空态卡在已有预约时会消失,入口不该跟着消失。
   * 不传则不渲染(匿名落地页走自己的登录 CTA 行)。
   */
  onSchedule?: () => void
}) => {
  const { t, i18n } = useTranslation('meetings')
  const {
    data: overview,
    isLoading,
    isError,
    refetch,
  } = useVideoMeetings(enabled)
  const data = overview?.scheduled

  const header = (title: string) => (
    <div className={headerRow}>
      <H lvl={3} margin={false}>
        {title}
      </H>
      {onSchedule && (
        <Button
          variant="secondary"
          size="sm"
          data-attr="schedule-meeting"
          onPress={onSchedule}
        >
          <RiAddLine size={16} />
          {t('scheduleMeeting', { ns: 'home' })}
        </Button>
      )}
    </div>
  )

  if (!enabled) return null
  if (isLoading || isError)
    return (
      <section>
        {header(t('home.scheduledTitle'))}
        <p>{t(isLoading ? 'loading' : 'error.loadFailed')}</p>
        {isError && (
          <button onClick={() => void refetch()}>{t('error.retry')}</button>
        )}
      </section>
    )
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
        {header(t('home.scheduledTitle'))}
        <PageState
          density="compact"
          surface="card"
          icon={<RiCalendarLine size={20} />}
          description={t('home.scheduledEmpty')}
        />
      </div>
    )
  }

  const visible = data

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
      {header(t('home.scheduledTitle'))}
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
                    canManage: !!m.is_owner,
                    eventId: m.event_id ?? null,
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
                        fontSize: '0.8125rem',
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
    </div>
  )
}
