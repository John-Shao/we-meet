import { useTranslation } from 'react-i18next'
import { RiCalendarLine } from '@remixicon/react'

import { PageState } from '@/components/PageState'
import { StateHint } from '@/components/StateHint'
import { css } from '@/styled-system/css'
import { Button } from '@/primitives'

import { useVideoMeetings } from '../api/videoMeetings'
import type { MeetingSelection } from './MeetingDetailPanel'
import {
  listCard,
  listRowDivider,
  rowBody,
  rowHeadingOneLine,
  rowIconTile,
  rowMetaBlock,
  sectionHeading,
} from './libraryStyles'

/** 一节整体的竖向堆叠(标题 + 列表 / 空态 / 加载)。 */
const sectionStack = css({
  width: '100%',
  marginTop: 'xl',
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
})

/**
 * 会议行。选中底色必须和基类写在**同一个 css()** 里:cx 叠加同属性原子类按
 * 样式表顺序取胜(见 memory: panda-cx-atomic-order-trap),拆开会随机丢选中态。
 * 几何与样板对齐(行首 48px 图标块、lg 内边距、lg 间距)。
 */
const rowButton = (selected: boolean) =>
  css({
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 'lg',
    minHeight: 'controlHeight.large',
    textAlign: 'left',
    border: 'none',
    backgroundColor: selected ? 'action.selected.bg' : 'transparent',
    color: selected ? 'action.selected.text' : 'text.primary',
    paddingY: 'md',
    paddingX: 'lg',
    cursor: 'pointer',
    transition:
      'background-color token(durations.fast), color token(durations.fast)',
    _hover: { backgroundColor: 'surface.canvas' },
    _focusVisible: {
      outline: '2px solid token(colors.border.focus)',
      outlineOffset: '-2px',
    },
  })

/** 时间那一行:与其它列表同一样式。 */
const rowTime = rowMetaBlock

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
  const {
    data: overview,
    isLoading,
    isError,
    refetch,
  } = useVideoMeetings(enabled)
  const data = overview?.scheduled

  /**
   * 节标题。
   *
   * 「预约会议」入口**曾经**收在这一行右侧,现已删除:会议主区顶部的动作行里
   * 已经有同一颗按钮,而那一行永远在屏上 —— 不需要靠标题行兜住可见性,同一屏
   * 出现两颗同款次按钮反而让人犹豫点哪个。预约出来的会议仍然出现在这一节里。
   */
  const header = (title: string) => <h3 className={sectionHeading}>{title}</h3>

  if (!enabled) return null
  if (isLoading || isError)
    return (
      <section className={sectionStack}>
        {header(t('home.scheduledTitle'))}
        <StateHint
          state={isError ? 'error' : 'loading'}
          action={
            isError ? (
              <Button
                variant="tertiary"
                size="sm"
                onPress={() => void refetch()}
              >
                {t('error.retry')}
              </Button>
            ) : undefined
          }
        >
          {t(isError ? 'error.loadFailed' : 'loading')}
        </StateHint>
      </section>
    )
  if (!data || data.length === 0) {
    if (!showEmpty) return null
    return (
      <div className={sectionStack}>
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
    <div className={sectionStack}>
      {header(t('home.scheduledTitle'))}
      <ul className={listCard}>
        {visible.map((m) => {
          const label = m.name || t('home.untitled')
          return (
            <li key={m.id} className={listRowDivider}>
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
                className={rowButton(selectedId === m.id)}
              >
                <span aria-hidden className={rowIconTile}>
                  <RiCalendarLine size={24} />
                </span>
                <span className={rowBody}>
                  <span className={rowHeadingOneLine}>{label}</span>
                  {m.scheduled_at && (
                    <span className={rowTime}>
                      {formatScheduledAt(
                        m.scheduled_at,
                        i18n.language,
                        t('home.today')
                      )}
                    </span>
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
