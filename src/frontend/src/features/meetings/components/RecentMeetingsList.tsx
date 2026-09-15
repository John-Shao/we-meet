import { Link } from 'wouter'

import { useTranslation } from 'react-i18next'
import { RiVidiconLine } from '@remixicon/react'

import { PageState } from '@/components/PageState'
import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'

import { useVideoMeetings } from '../api/videoMeetings'
import type { MeetingSelection } from './MeetingDetailPanel'

// The overview returns the ten latest actual sessions.
const COLLAPSED_COUNT = 10

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
      <section>
        <H lvl={3}>{t('home.recentTitle')}</H>
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
        <H lvl={3} margin={false}>
          {t('home.recentTitle')}
        </H>
        <PageState
          density="compact"
          surface="card"
          icon={<RiVidiconLine size={20} />}
          description={t('home.recentEmpty')}
        />
        <Link href="/meeting/notes?source_type=meeting">{t('video.more')}</Link>
      </div>
    )
  }

  const visible = data.slice(0, COLLAPSED_COUNT)

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
              key={m.meeting_session_id ?? m.id}
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
                    timeIso: m.started_at,
                    sessionId: m.meeting_session_id,
                    sessionStatus: m.status,
                    canManage: !!m.is_owner,
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
                      selectedId === (m.meeting_session_id ?? m.id)
                        ? 'greyscale.100'
                        : 'transparent',
                    padding: '0.875rem 1rem',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.50' },
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
                    backgroundColor: 'brand.50',
                    color: 'brand.500',
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
                  {m.started_at && (
                    <Text
                      className={css({
                        fontSize: '0.8125rem',
                        color: 'greyscale.600',
                        marginTop: '0.125rem',
                      })}
                    >
                      {t(
                        m.status === 'active' ? 'video.active' : 'video.ended'
                      )}{' '}
                      · {formatRelativeTime(m.started_at, i18n.language)}
                    </Text>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <Link
        href="/meeting/notes?source_type=meeting"
        className={css({ alignSelf: 'center', color: 'primary.700' })}
      >
        {t('video.more')}
      </Link>
    </div>
  )
}
