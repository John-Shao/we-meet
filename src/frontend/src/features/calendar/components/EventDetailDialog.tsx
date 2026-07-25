import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RiCheckLine, RiCloseLine, RiQuestionLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { useUser } from '@/features/auth'

import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'

interface Props {
  event: CalendarEvent
  onRsvp: (status: RSVPStatus) => void
  onJoin: () => void
  onClose: () => void
  /** Organizer-only: enables the 编辑 / 删除 actions. */
  canManage?: boolean
  onEdit?: () => void
  onDelete?: () => void
  /** 分享日程到聊天(不限组织者);缺省则不显示分享按钮。 */
  onShare?: () => void
}

/**
 * Event detail popup opened by clicking a grid event (对标飞书). Carries the
 * RSVP (接受/待定/拒绝) + 进入会议 actions the agenda used to show inline, so the
 * grid keeps full functionality.
 */
export const EventDetailDialog = ({
  event,
  onRsvp,
  onJoin,
  onClose,
  canManage,
  onEdit,
  onDelete,
  onShare,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')
  const { user } = useUser()
  const [rsvp, setRsvp] = useState<RSVPStatus | null>(event.my_rsvp ?? null)
  // 「更多」菜单(删除收纳其中,对标飞书)。
  const [moreOpen, setMoreOpen] = useState(false)
  // 会议号/链接的「已复制」瞬时态。
  const [copied, setCopied] = useState<'id' | 'link' | null>(null)
  const meetingLink = event.room_slug
    ? `${window.location.origin}/${event.room_slug}`
    : ''
  const copyMeeting = async (kind: 'id' | 'link', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500)
    } catch {
      /* 剪贴板被策略拒绝:静默,用户可手动选择文本 */
    }
  }
  // 详情可被非参与人打开(分享到群后凭 id 只读),但表态仍限参与人/组织者 ——
  // 后端 rsvp 走受限 queryset,非参与人点了必失败,故直接不渲染 RSVP 区。
  const canRsvp =
    !!user &&
    (event.organizer?.id === user.id ||
      event.attendees.some((a) => a.id === user.id))

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, {
      hour: '2-digit',
      minute: '2-digit',
    })
  const sameDay =
    new Date(event.start_at).toDateString() ===
    new Date(event.end_at).toDateString()
  const when = event.all_day
    ? new Date(event.start_at).toLocaleDateString(i18n.language, {
        dateStyle: 'medium',
        timeZone: event.timezone || undefined,
      })
    : `${fmt(event.start_at)} – ${sameDay ? fmtTime(event.end_at) : fmt(event.end_at)}`

  const handle = (status: RSVPStatus) => {
    setRsvp(status)
    onRsvp(status)
  }

  return (
    <Modal onClose={onClose} ariaLabel={event.title} maxWidth="420px">
      <div className={css({ padding: '1.25rem' })}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1.125rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {event.title}
        </h2>
        <p
          className={css({
            margin: '0.5rem 0 0',
            fontSize: '0.875rem',
            color: 'greyscale.700',
          })}
        >
          {when}
        </p>
        {/* P2-M1 重复标识:主事件按 FREQ 显示预设名;子场次显示「重复日程的一次」。 */}
        {(event.recurrence || event.recurrence_parent) && (
          <p
            className={css({
              margin: '0.25rem 0 0',
              fontSize: '0.75rem',
              color: 'greyscale.500',
            })}
          >
            🔁{' '}
            {event.recurrence_parent
              ? t('detail.recurrenceOccurrence')
              : t(recurrenceLabelKey(event.recurrence))}
          </p>
        )}
        {/* 人数信息由下方「参与人 (N)」承载,此处只留组织者,免重复。 */}
        <p
          className={css({
            margin: '0.25rem 0 0',
            fontSize: '0.75rem',
            color: 'greyscale.500',
          })}
        >
          {t('card.organizer')}: {event.organizer?.full_name || '—'}
        </p>
        {/* 会议信息(对标飞书:日程详情内嵌会议区块)—— 会议号/链接是「把会
            发给别人」的高频动作,原先只有底部一个「进入会议」按钮拿不到。 */}
        {event.room_slug && (
          <div className={meetingBoxCls}>
            <div className={meetingRowCls}>
              <span className={meetingLabelCls}>{t('detail.meetingNo')}</span>
              <span className={meetingValueCls}>
                {formatSlugDigits(event.room_slug)}
              </span>
              <button
                type="button"
                onClick={() => void copyMeeting('id', event.room_slug!)}
                data-testid="detail-copy-no"
                className={meetingCopyCls}
              >
                {copied === 'id' ? t('detail.copied') : t('detail.copy')}
              </button>
            </div>
            <div className={meetingRowCls}>
              <span className={meetingLabelCls}>{t('detail.meetingLink')}</span>
              <span className={cx(meetingValueCls, meetingLinkCls)}>
                {meetingLink}
              </span>
              <button
                type="button"
                onClick={() => void copyMeeting('link', meetingLink)}
                data-testid="detail-copy-link"
                className={meetingCopyCls}
              >
                {copied === 'link' ? t('detail.copied') : t('detail.copy')}
              </button>
            </div>
          </div>
        )}
        {event.description && (
          <p
            className={css({
              margin: '0.75rem 0 0',
              fontSize: '0.8125rem',
              color: 'greyscale.700',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            })}
          >
            {event.description}
          </p>
        )}
        {event.reminders && event.reminders.length > 0 && (
          <p
            className={css({
              margin: '0.5rem 0 0',
              fontSize: '0.75rem',
              color: 'greyscale.500',
            })}
          >
            🔔 {t('card.reminder')}:{' '}
            {event.reminders
              .map((m) => t('form.reminderMinutes', { count: m }))
              .join('、')}
          </p>
        )}

        {/* RSVP —— 仅参与人/组织者可见(非参与人是「被分享者」,只读) */}
        {canRsvp && (
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.375rem',
            marginTop: '1rem',
          })}
        >
          <span
            className={css({
              fontSize: '0.75rem',
              color: 'greyscale.500',
              marginRight: '0.25rem',
            })}
          >
            {t('rsvp.label')}:
          </span>
          {(['accepted', 'tentative', 'declined'] as RSVPStatus[]).map(
            (status) => (
              <button
                key={status}
                type="button"
                onClick={() => handle(status)}
                data-testid={`detail-rsvp-${status}`}
                // 选中/未选两个完整类整体切换 —— cx 叠加同属性原子类时按
                // 样式表顺序取胜(非书写顺序),选中态的 white 字曾被基类的
                // greyscale.700 盖掉,蓝底深灰字区分度差。
                className={rsvp === status ? rsvpBtnActive : rsvpBtn}
              >
                {t(`rsvp.${status}`)}
              </button>
            )
          )}
        </div>
        )}

        {/* 参与人列表(对齐 App 端:RSVP 状态图标 + 名字 + 组织者标签)。 */}
        {event.attendees.length > 0 && (
          <div
            className={css({
              marginTop: '1rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid token(colors.greyscale.100)',
            })}
          >
            <div
              className={css({
                fontSize: '0.8125rem',
                fontWeight: 'medium',
                color: 'greyscale.800',
                marginBottom: '0.375rem',
              })}
            >
              {t('detail.attendeesTitle', { count: event.attendees.length })}
            </div>
            <ul
              className={css({
                listStyle: 'none',
                margin: 0,
                padding: 0,
                maxHeight: '10.5rem',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.375rem',
              })}
            >
              {event.attendees.map((a, i) => {
                const StatusIcon =
                  a.rsvp === 'accepted'
                    ? RiCheckLine
                    : a.rsvp === 'declined'
                      ? RiCloseLine
                      : RiQuestionLine
                return (
                  <li
                    key={a.id ?? i}
                    className={css({
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    })}
                  >
                    <StatusIcon
                      size={15}
                      aria-label={a.rsvp ?? 'needs_action'}
                      className={cx(
                        css({ flexShrink: 0 }),
                        a.rsvp === 'accepted'
                          ? css({ color: 'primary.600' })
                          : a.rsvp === 'declined'
                            ? css({ color: '#dc2626' })
                            : css({ color: 'greyscale.400' })
                      )}
                    />
                    <span
                      className={css({
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '0.8125rem',
                        color: 'greyscale.800',
                      })}
                    >
                      {a.full_name || a.email || '—'}
                    </span>
                    {a.role === 'organizer' && (
                      <span
                        className={css({
                          flexShrink: 0,
                          fontSize: '0.6875rem',
                          color: 'primary.600',
                        })}
                      >
                        {t('card.organizer')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Actions: 分享/编辑/更多(organizer)靠左,进入会议靠右 */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginTop: '1.25rem',
          })}
        >
          {onShare && (
            <button
              type="button"
              onClick={onShare}
              data-testid="detail-share"
              className={detailBtn}
            >
              {t('detail.share')}
            </button>
          )}
          {canManage && (
            <>
              <button
                type="button"
                onClick={onEdit}
                data-testid="detail-edit"
                className={detailBtn}
              >
                {t('detail.edit')}
              </button>
              {/* 删除收进「更多」:高危操作不与常用操作并排(对标飞书)。 */}
              <div className={moreWrapCls}>
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  data-testid="detail-more"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  className={detailBtn}
                >
                  {t('detail.more')}
                </button>
                {moreOpen && (
                  <>
                    {/* 透明遮罩兜住「点外部关闭」,省掉全局监听器。 */}
                    <div
                      className={moreBackdropCls}
                      onClick={() => setMoreOpen(false)}
                    />
                    <div role="menu" className={moreMenuCls}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false)
                          onDelete?.()
                        }}
                        data-testid="detail-delete"
                        className={moreItemDangerCls}
                      >
                        {t('detail.delete')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {event.room_slug && (
            <button
              type="button"
              onClick={onJoin}
              data-testid="detail-join"
              className={css({
                marginLeft: 'auto',
                paddingX: '1rem',
                paddingY: '0.5rem',
                border: 'none',
                borderRadius: '0.5rem',
                backgroundColor: 'primary.500',
                color: 'white',
                fontSize: '0.875rem',
                fontWeight: 'medium',
                cursor: 'pointer',
              })}
            >
              {t('card.join')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** RRULE → 预设文案 key(与 CreateEventDialog 的预设一一对应;非预设归自定义)。 */
const recurrenceLabelKey = (rrule: string): string => {
  if (rrule.includes('FREQ=WEEKLY') && rrule.includes('BYDAY=MO,TU,WE,TH,FR'))
    return 'form.repeatWeekdays'
  if (rrule.includes('FREQ=DAILY')) return 'form.repeatDaily'
  if (rrule.includes('FREQ=WEEKLY')) return 'form.repeatWeekly'
  if (rrule.includes('FREQ=MONTHLY')) return 'form.repeatMonthly'
  return 'detail.recurrenceCustom'
}

const rsvpBtn = css({
  paddingX: '0.625rem',
  paddingY: '0.25rem',
  borderRadius: '999px',
  border: '1px solid token(colors.greyscale.300)',
  fontSize: '0.75rem',
  cursor: 'pointer',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  _hover: { backgroundColor: 'greyscale.100' },
})

const rsvpBtnActive = css({
  paddingX: '0.625rem',
  paddingY: '0.25rem',
  borderRadius: '999px',
  border: '1px solid token(colors.primary.500)',
  fontSize: '0.75rem',
  fontWeight: 'medium',
  cursor: 'pointer',
  backgroundColor: 'primary.500',
  color: 'white',
})

const detailBtn = css({
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})

/** 会议号按位数分组:8→4+4、9→3+3+3、6→3+3(与会议详情面板同口径)。 */
const formatSlugDigits = (slug: string): string => {
  const digits = slug.replace(/\D/g, '')
  if (digits.length === 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`
  if (digits.length === 9)
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
  if (digits.length === 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`
  return slug
}

const meetingBoxCls = css({
  marginTop: '0.75rem',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.50',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
})

const meetingRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
})

const meetingLabelCls = css({
  flexShrink: 0,
  fontSize: '0.75rem',
  color: 'greyscale.500',
})

const meetingValueCls = css({
  minWidth: 0,
  flex: 1,
  fontSize: '0.8125rem',
  color: 'greyscale.800',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const meetingLinkCls = css({ color: 'greyscale.600' })

const meetingCopyCls = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  color: 'primary.600',
  fontSize: '0.75rem',
  cursor: 'pointer',
  _hover: { textDecoration: 'underline' },
})

const moreWrapCls = css({ position: 'relative', display: 'inline-flex' })

// 遮罩只负责「点外部关闭」,层级压在菜单之下、其余 UI 之上。
const moreBackdropCls = css({ position: 'fixed', inset: 0, zIndex: 10 })

const moreMenuCls = css({
  position: 'absolute',
  top: 'calc(100% + 0.25rem)',
  left: 0,
  zIndex: 11,
  minWidth: '8rem',
  paddingY: '0.25rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
})

// 与 rsvpBtn 同因:不用 cx 叠加同属性(danger 色可能被基类盖掉),完整类。
const moreItemDangerCls = css({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: 'none',
  backgroundColor: 'transparent',
  color: 'danger.600',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'danger.50' },
})
