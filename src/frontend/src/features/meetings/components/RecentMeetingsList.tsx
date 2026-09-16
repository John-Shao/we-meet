import { Link } from 'wouter'

import { useTranslation } from 'react-i18next'
import { RiVidiconLine } from '@remixicon/react'

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

// The overview returns the twenty latest actual sessions.
const COLLAPSED_COUNT = 20

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

/** 一节整体的竖向堆叠(标题 + 列表 / 空态 / 加载)。与预约列表同一档间距。 */
const sectionStack = css({
  width: '100%',
  marginTop: 'xl',
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
})

/**
 * 会议行。选中底色与基类写在**同一个 css()** 里:cx 叠加同属性原子类按样式表
 * 顺序取胜(见 memory: panda-cx-atomic-order-trap),拆开会随机丢选中态。
 *
 * 几何与样板对齐(行首 48px 图标块、lg 内边距、lg 间距):行高不再靠自己的
 * paddingY 决定,与实录/纪要/录音的行是同一档。
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

const rowTime = rowMetaBlock

const moreLink = css({
  alignSelf: 'center',
  textStyle: 'labelLarge',
  color: 'text.link',
  textDecoration: 'none',
  borderRadius: 'field',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

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
  const {
    data: overview,
    isLoading,
    isError,
    refetch,
  } = useVideoMeetings(enabled)
  const data = overview?.recent

  if (!enabled) return null
  if (isLoading || isError)
    return (
      <section className={sectionStack}>
        <h3 className={sectionHeading}>{t('home.recentTitle')}</h3>
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
        <h3 className={sectionHeading}>{t('home.recentTitle')}</h3>
        <PageState
          density="compact"
          surface="card"
          icon={<RiVidiconLine size={20} />}
          description={t('home.recentEmpty')}
        />
        <Link href="/meeting/notes?source_type=meeting" className={moreLink}>
          {t('video.more')}
        </Link>
      </div>
    )
  }

  const visible = data.slice(0, COLLAPSED_COUNT)

  return (
    <div className={sectionStack}>
      <h3 className={sectionHeading}>{t('home.recentTitle')}</h3>
      <ul className={listCard}>
        {visible.map((m) => {
          const label = m.name || t('home.untitled')
          const id = m.meeting_session_id ?? m.id
          return (
            <li key={id} className={listRowDivider}>
              <button
                type="button"
                data-testid={`recent-row-${m.id}`}
                onClick={() =>
                  onSelect({
                    kind: 'recent',
                    id: m.id,
                    name: m.name,
                    slug: m.slug,
                    timeIso: m.started_at,
                    sessionId: m.meeting_session_id,
                    sessionStatus: m.status,
                    canManage: !!m.is_owner,
                  })
                }
                className={rowButton(selectedId === id)}
              >
                <span aria-hidden className={rowIconTile}>
                  <RiVidiconLine size={24} />
                </span>
                <span className={rowBody}>
                  <span className={rowHeadingOneLine}>{label}</span>
                  {m.started_at && (
                    <span className={rowTime}>
                      {t(
                        m.status === 'active' ? 'video.active' : 'video.ended'
                      )}{' '}
                      · {formatRelativeTime(m.started_at, i18n.language)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <Link href="/meeting/notes?source_type=meeting" className={moreLink}>
        {t('video.more')}
      </Link>
    </div>
  )
}
