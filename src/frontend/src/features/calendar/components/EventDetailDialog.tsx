import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiBuilding2Line,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileList2Line,
  RiFileTextLine,
  RiGroupLine,
  RiLockLine,
  RiNotification3Line,
  RiPencilLine,
  RiQuestionLine,
  RiRepeatLine,
  RiShareForwardLine,
  RiUserLine,
  RiVidiconLine,
  type RemixiconComponentType,
} from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { linkBtnCls } from '@/styles/controls'
import { Button } from '@/primitives'
import { Modal } from '@/components/Modal'
import { useUser } from '@/features/auth'
import { MemberAvatar } from '@/features/contacts'
import { navigateTo } from '@/navigation/navigateTo'
import { useMeetingSummary } from '@/features/meetings/api/fetchMeeting'
import { roomScheduleLabel } from '@/features/meeting-rooms/utils/roomLabel'

import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'
import {
  effectiveReminder,
  reminderOptionLabel,
} from '../hooks/useCalendarSettings'

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
 * Event detail popup opened by clicking a grid event (对标飞书).
 *
 * 布局三段(2026-07 对标飞书重排):
 * 1. 头部固定 —— 色块+标题一行,操作(分享/编辑/删除/关闭)收成右上角图标钮,
 *    时间用主色强调并带「今天」标记;
 * 2. 信息区滚动 —— 每条信息一行「图标沟槽 + 内容」,取代原先散落的
 *    emoji 前缀 + 「标签: 值」行文,信息类型靠左侧图标一眼可辨;
 * 3. 底部固定 —— RSVP 三档整行等分(原先是正文中间的小胶囊,主决策却最难点)。
 *
 * 「进入会议」跟着会议号/链接进信息区(对标飞书的「发起视频会议」),不再独占
 * 底部操作栏 —— 底栏留给表态。
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
  const { t, i18n } = useTranslation(['calendar', 'meeting-rooms'])
  const { user } = useUser()
  const [rsvp, setRsvp] = useState<RSVPStatus | null>(event.my_rsvp ?? null)
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
  // 会后纪要(阶段 2:日程详情覆盖「会前预约 → 会后纪要」全生命周期)。
  // 仅已结束且有房间时才查,避免给每个未来日程平白多打一次 404。
  // 纪要读权限本就是「拿到房间 id 即可」(RoomViewSet SAFE_METHODS 放行),
  // 与详情已暴露的 room_slug 同口径,不新增暴露面。
  const ended = new Date(event.end_at).getTime() < Date.now()
  const { data: summary } = useMeetingSummary(
    ended && event.room ? event.room : undefined
  )
  // 摘要预览:人工编辑版优先(effective_content),回退 AI 原文。
  const summaryPreview = (summary?.effective_content || summary?.content || '')
    .replace(/[#*`>\-\n]+/g, ' ')
    .trim()
    .slice(0, 90)

  // 详情可被非参与人打开(分享到群后凭 id 只读),但表态只限受邀参与人。
  // 组织者恒为 accepted；非参与人和组织者都不渲染 RSVP 区。
  const canRsvp =
    !!user &&
    event.organizer?.id !== user.id &&
    event.attendees.some((a) => a.id === user.id)
  const displayTitle = event.details_redacted
    ? event.visibility === 'private'
      ? t('detail.privateEvent')
      : t('visibility.busy')
    : event.title

  const fmtDate = (iso: string, tz?: string) =>
    new Date(iso).toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
      timeZone: tz,
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
    ? fmtDate(event.start_at, event.timezone || undefined)
    : sameDay
      ? `${fmtDate(event.start_at)} ${fmtTime(event.start_at)} – ${fmtTime(event.end_at)}`
      : `${fmtDate(event.start_at)} ${fmtTime(event.start_at)} – ${fmtDate(event.end_at)} ${fmtTime(event.end_at)}`
  const isToday =
    new Date(event.start_at).toDateString() === new Date().toDateString()

  // 表态即时反映到参与人列表:日历页的 detailEvent 是点开时的快照,invalidate
  // 只刷列表查询、不会回填这个 prop,不覆写的话自己那行会一直停在旧状态
  // (IM 宿主虽会 refetch,也有一次往返的延迟)。
  const attendees =
    rsvp && user
      ? event.attendees.map((a) => (a.id === user.id ? { ...a, rsvp } : a))
      : event.attendees

  const acceptedCount = attendees.filter((a) => a.rsvp === 'accepted').length

  const handle = (status: RSVPStatus) => {
    setRsvp(status)
    onRsvp(status)
  }

  return (
    <Modal onClose={onClose} ariaLabel={displayTitle} maxWidth="440px">
      {/* 头部:标题 + 右上角图标操作 + 时间 —— 固定不随信息区滚动 */}
      <div className={headerCls}>
        <div className={headerTopCls}>
          <span className={dotCls} aria-hidden="true" />
          <h2 className={titleCls}>{displayTitle}</h2>
          <div className={headerActionsCls}>
            {onShare &&
              !event.details_redacted &&
              event.visibility !== 'private' && (
                <Button
                  variant="quaternaryText"
                  size="icon28"
                  onPress={onShare}
                  data-testid="detail-share"
                  tooltip={t('detail.share')}
                  aria-label={t('detail.share')}
                >
                  <RiShareForwardLine size={16} />
                </Button>
              )}
            {canManage && (
              <>
                <Button
                  variant="quaternaryText"
                  size="icon28"
                  onPress={onEdit}
                  data-testid="detail-edit"
                  tooltip={t('detail.edit')}
                  aria-label={t('detail.edit')}
                >
                  <RiPencilLine size={16} />
                </Button>
                {/* 删除与编辑/分享并排(对标飞书):删除本就走二次确认,
                    再套一层「更多」只是多一次点击。悬停转红做危险提示。 */}
                <Button
                  variant="quaternaryDanger"
                  size="icon28"
                  onPress={onDelete}
                  data-testid="detail-delete"
                  tooltip={t('detail.delete')}
                  aria-label={t('detail.delete')}
                >
                  <RiDeleteBinLine size={16} />
                </Button>
              </>
            )}
            <Button
              variant="quaternaryText"
              size="icon28"
              onPress={onClose}
              data-testid="detail-close"
              tooltip={t('detail.close')}
              aria-label={t('detail.close')}
            >
              <RiCloseLine size={18} />
            </Button>
          </div>
        </div>
        <p className={whenCls}>
          {when}
          {isToday && <span className={todayTagCls}>{t('grid.today')}</span>}
        </p>
      </div>

      {/* 信息区:一行一条「图标 + 内容」,超长时只滚这一段 */}
      <div className={bodyCls}>
        {event.details_redacted && (
          <InfoRow icon={RiLockLine} testId="detail-private-redacted">
            <span className={mutedTextCls}>
              {t(
                event.visibility === 'private'
                  ? 'detail.privateEventHint'
                  : 'visibility.busyHint'
              )}
            </span>
          </InfoRow>
        )}
        {/* P2-M1 重复标识:主事件按 FREQ 显示预设名;子场次显示「重复日程的一次」。 */}
        {(event.recurrence || event.recurrence_parent) && (
          <InfoRow icon={RiRepeatLine}>
            <span className={mutedTextCls}>
              {event.recurrence_parent
                ? t('detail.recurrenceOccurrence')
                : t(recurrenceLabelKey(event.recurrence))}
            </span>
          </InfoRow>
        )}

        {/* 会议信息(对标飞书:日程详情内嵌会议区块)—— 会议号/链接是「把会
            发给别人」的高频动作,原先只有底部一个「进入会议」按钮拿不到。 */}
        {event.room_slug && (
          <InfoRow icon={RiVidiconLine}>
            <Button
              variant="primary"
              size="dense"
              onPress={onJoin}
              data-testid="detail-join"
            >
              {t('card.join')}
            </Button>
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
                  className={linkBtnCls}
                >
                  {copied === 'id' ? t('detail.copied') : t('detail.copy')}
                </button>
              </div>
              <div className={meetingRowCls}>
                <span className={meetingLabelCls}>
                  {t('detail.meetingLink')}
                </span>
                <span className={cx(meetingValueCls, meetingLinkCls)}>
                  {meetingLink}
                </span>
                <button
                  type="button"
                  onClick={() => void copyMeeting('link', meetingLink)}
                  data-testid="detail-copy-link"
                  className={linkBtnCls}
                >
                  {copied === 'link' ? t('detail.copied') : t('detail.copy')}
                </button>
              </div>
            </div>
          </InfoRow>
        )}

        {/* P9 实体会议室 —— 刻意与上面的「进入会议」分行:那是 LiveKit 视频房间,
            混在一起只会加剧两个 room 的命名混淆。 */}
        {event.meeting_room && (
          <InfoRow icon={RiBuilding2Line} testId="detail-meeting-room">
            <span className={bodyTextCls}>
              {roomScheduleLabel(
                event.meeting_room.node.name,
                event.meeting_room,
                t('meeting-rooms:unit.people', {
                  count: event.meeting_room.capacity,
                })
              )}
              {event.meeting_room.booking_status === 'conflict' && (
                <span className={css({ color: 'danger.600' })}>
                  {' '}
                  · {t('detail.meetingRoomConflict')}
                </span>
              )}
            </span>
          </InfoRow>
        )}

        {/* 组织者:头像 + 名字 + 标签,与参与人列表同一套人物呈现 */}
        {!event.details_redacted && (
          <InfoRow icon={RiUserLine}>
            <span className={personCls}>
              <MemberAvatar
                name={event.organizer?.full_name || '?'}
                src={event.organizer?.avatar_url}
                size="1.375rem"
              />
              <span className={personNameCls}>
                {event.organizer?.full_name || '—'}
              </span>
              <span className={organizerTagCls}>{t('card.organizer')}</span>
            </span>
          </InfoRow>
        )}

        {/* 参与人列表(对齐 App 端:RSVP 状态图标 + 名字 + 组织者标签)。 */}
        {attendees.length > 0 && (
          <InfoRow icon={RiGroupLine}>
            <div className={attendeeHeadCls}>
              {t('detail.attendeeCount', { count: attendees.length })}
              {acceptedCount > 0 && (
                <span className={mutedTextCls}>
                  {' · '}
                  {t('detail.attendeeAccepted', { count: acceptedCount })}
                </span>
              )}
            </div>
            <ul className={attendeeListCls}>
              {attendees.map((a, i) => {
                const StatusIcon =
                  a.rsvp === 'accepted'
                    ? RiCheckLine
                    : a.rsvp === 'declined'
                      ? RiCloseLine
                      : RiQuestionLine
                return (
                  <li key={a.id ?? i} className={attendeeItemCls}>
                    <MemberAvatar
                      name={a.full_name || a.email || '?'}
                      src={a.avatar_url}
                      size="1.375rem"
                    />
                    <span className={personNameCls}>
                      {a.full_name || a.email || '—'}
                    </span>
                    {a.role === 'organizer' && (
                      <span className={organizerTagCls}>
                        {t('card.organizer')}
                      </span>
                    )}
                    {a.role === 'optional' && (
                      <span className={organizerTagCls}>
                        {t('detail.optionalAttendee')}
                      </span>
                    )}
                    <StatusIcon
                      size={16}
                      aria-label={a.rsvp ?? 'needs_action'}
                      className={cx(
                        statusIconCls,
                        a.rsvp === 'accepted'
                          ? statusAcceptedCls
                          : a.rsvp === 'declined'
                            ? statusDeclinedCls
                            : statusPendingCls
                      )}
                    />
                  </li>
                )
              })}
            </ul>
          </InfoRow>
        )}

        {/* 会后纪要:「会前(会议号/链接)→ 会后(纪要)」的完整生命周期。这里只给
            摘要 + 入口,完整纪要/待办/转录仍在会议详情页渲染 —— 不把重内容塞进
            这个紧凑弹窗,也不重复实现一遍。 */}
        {ended && event.room && summary && summary.status !== 'failed' && (
          <InfoRow icon={RiFileList2Line}>
            <button
              type="button"
              onClick={() => {
                onClose()
                navigateTo('meetingDetail', event.room)
              }}
              data-testid="detail-summary"
              className={summaryBoxCls}
            >
              <span className={summaryTitleCls}>
                {t('detail.summary')}
                {summary.status === 'pending' && (
                  <span className={summaryPendingCls}>
                    {t('detail.summaryPending')}
                  </span>
                )}
              </span>
              {summaryPreview && (
                <span className={summaryPreviewCls}>{summaryPreview}…</span>
              )}
              <span className={summaryLinkCls}>{t('detail.summaryView')}</span>
            </button>
          </InfoRow>
        )}

        {event.description && (
          <InfoRow icon={RiFileTextLine}>
            <p className={descriptionCls}>{event.description}</p>
          </InfoRow>
        )}

        {/* 只显示真正会响的那一条(后端按 max 推一次),文案走统一口径 ——
            原来把 reminders 全列出来会把 0 显示成「0 分钟前」、1440 显示成
            「1440 分钟前」。 */}
        {effectiveReminder(event.reminders) != null && (
          <InfoRow icon={RiNotification3Line}>
            <span className={mutedTextCls}>
              {reminderOptionLabel(t, effectiveReminder(event.reminders)!)}
            </span>
          </InfoRow>
        )}
      </div>

      {/* 底栏 RSVP —— 三档等分整行(对标飞书);仅受邀参与人可见。
          组织者恒为接受；被分享者只读，二者均不渲染底栏。 */}
      {canRsvp && (
        <div
          className={footerCls}
          role="group"
          aria-label={t('rsvp.label')}
          data-testid="detail-rsvp"
        >
          {(['accepted', 'tentative', 'declined'] as RSVPStatus[]).map(
            (status) => (
              // 选中/未选走 variant 切换:基元的每个 variant 自身就是一整套
              // 完整规则,不会出现手搓时那种「底色赢了、字色被基类盖掉」的原子类
              // 顺序问题,所以不必再抄两份完整类。
              <Button
                key={status}
                variant={rsvp === status ? 'primary' : 'secondary'}
                size="dense"
                onPress={() => handle(status)}
                data-testid={`detail-rsvp-${status}`}
                aria-pressed={rsvp === status}
                className={rsvpFlexCls}
              >
                {t(`rsvp.${status}`)}
              </Button>
            )
          )}
        </div>
      )}
    </Modal>
  )
}

/** 信息行:左侧固定图标沟槽 + 右侧内容,让各类信息纵向对齐(对标飞书)。 */
const InfoRow = ({
  icon: Icon,
  testId,
  children,
}: {
  icon: RemixiconComponentType
  testId?: string
  children: ReactNode
}) => (
  <div className={infoRowCls} data-testid={testId}>
    <Icon size={16} className={infoIconCls} />
    <div className={infoBodyCls}>{children}</div>
  </div>
)

/** RRULE → 预设文案 key(与 CreateEventDialog 的预设一一对应;非预设归自定义)。 */
const recurrenceLabelKey = (rrule: string): string => {
  if (rrule.includes('FREQ=WEEKLY') && rrule.includes('BYDAY=MO,TU,WE,TH,FR'))
    return 'form.repeatWeekdays'
  if (rrule.includes('FREQ=DAILY')) return 'form.repeatDaily'
  if (rrule.includes('FREQ=WEEKLY')) return 'form.repeatWeekly'
  if (rrule.includes('FREQ=MONTHLY')) return 'form.repeatMonthly'
  return 'detail.recurrenceCustom'
}

/* ---------- header ---------- */

const headerCls = css({
  flexShrink: 0,
  padding: '1.125rem 1.25rem 0.875rem',
})

const headerTopCls = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
})

// 色块对齐标题首行的视觉中心(对标飞书的日历色标)。
const dotCls = css({
  flexShrink: 0,
  width: '0.625rem',
  height: '0.625rem',
  marginTop: '0.375rem',
  borderRadius: '0.1875rem',
  backgroundColor: 'primary.500',
  _dark: { backgroundColor: 'primaryDark.500' },
})

const titleCls = css({
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: '1.0625rem',
  fontWeight: 'bold',
  lineHeight: 1.4,
  color: 'greyscale.900',
  overflowWrap: 'anywhere',
})

const headerActionsCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  marginTop: '-0.125rem',
})

// 图标钮走小控件圆角 6px(按钮视觉标准:常规 8 / 小控件 6)。
// 时间是这个弹窗的第一信息,用主色 + 中号字重压过其余灰字。
const whenCls = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.375rem',
  margin: '0.5rem 0 0',
  paddingLeft: '1.125rem',
  fontSize: '0.875rem',
  fontWeight: 'medium',
  color: 'primary.600',
  _dark: { color: 'primaryDark.700' },
})

const todayTagCls = css({
  paddingX: '0.375rem',
  paddingY: '0.0625rem',
  borderRadius: 6,
  backgroundColor: 'brand.100',
  color: 'brand.700',
  fontSize: '0.6875rem',
  fontWeight: 'medium',
  _dark: { backgroundColor: 'primaryDark.100', color: 'primaryDark.800' },
})

/* ---------- body / info rows ---------- */

const bodyCls = css({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  paddingX: '1.25rem',
  paddingBottom: '0.75rem',
})

const infoRowCls = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.625rem',
  paddingY: '0.4375rem',
})

const infoIconCls = css({
  flexShrink: 0,
  marginTop: '0.1875rem',
  color: 'greyscale.500',
})

const infoBodyCls = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.375rem',
})

const bodyTextCls = css({ fontSize: '0.8125rem', color: 'greyscale.800' })

const mutedTextCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })

const descriptionCls = css({
  margin: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})

/* ---------- people ---------- */

const personCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
  maxWidth: '100%',
})

const personNameCls = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '0.8125rem',
  color: 'greyscale.800',
})

const organizerTagCls = css({
  flexShrink: 0,
  paddingX: '0.25rem',
  paddingY: '0.0625rem',
  borderRadius: 6,
  backgroundColor: 'primary.100',
  color: 'primary.700',
  fontSize: '0.6875rem',
  _dark: { backgroundColor: 'primaryDark.100', color: 'primaryDark.800' },
})

const attendeeHeadCls = css({
  fontSize: '0.8125rem',
  fontWeight: 'medium',
  color: 'greyscale.800',
})

const attendeeListCls = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  width: '100%',
  maxHeight: '9rem',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
})

const attendeeItemCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
})

// 状态图标推到行尾:名字左对齐成列,状态自成一列,扫读更快。
const statusIconCls = css({ flexShrink: 0, marginLeft: 'auto' })
const statusAcceptedCls = css({
  color: 'primary.600',
  _dark: { color: 'primaryDark.700' },
})
const statusDeclinedCls = css({ color: 'danger.600' })
const statusPendingCls = css({ color: 'greyscale.400' })

/* ---------- meeting ---------- */

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
  width: '100%',
  paddingX: '0.625rem',
  paddingY: '0.4375rem',
  borderRadius: 8,
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

/* ---------- summary ---------- */

const summaryBoxCls = css({
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.125rem',
  textAlign: 'left',
  paddingX: '0.625rem',
  paddingY: '0.4375rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: 8,
  backgroundColor: 'greyscale.000',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.50' },
})

const summaryTitleCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.8125rem',
  fontWeight: 'medium',
  color: 'greyscale.800',
})

const summaryPendingCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })

// 两行截断:panda 不认 WebkitBoxOrient 驼峰键,用 lineClamp 简写。
const summaryPreviewCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.600',
  lineClamp: '2',
  overflow: 'hidden',
})

const summaryLinkCls = css({
  fontSize: '0.75rem',
  color: 'primary.600',
  fontWeight: 'medium',
  _dark: { color: 'primaryDark.700' },
})

/* ---------- footer RSVP ---------- */

const footerCls = css({
  flexShrink: 0,
  display: 'flex',
  gap: '0.5rem',
  paddingX: '1.25rem',
  paddingY: '0.875rem',
  borderTop: '1px solid token(colors.greyscale.100)',
})

/** 三个 RSVP 键平分底栏宽度;其余外观全交给基元的 primary / secondary。 */
const rsvpFlexCls = css({ flex: 1 })
