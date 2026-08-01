import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiUserFollowLine } from '@remixicon/react'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { navGlyphCls } from '@/styles/controls'
import { Modal } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
import {
  CreateEventDialog,
  MiniCalendar,
  fetchFreeBusy,
  fetchCalendarEvents,
  busyPeopleInRange,
  suggestCommonSlots,
  useCalendarSettings,
  type CalendarEvent,
  type RSVPStatus,
  type SuggestedSlot,
} from '@/features/calendar'

import { resolveImUsers } from '../api/resolveImUsers'
import { Avatar } from './Avatar'
import { buildEventCardBody } from './eventCard'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  onClose: () => void
}

/** px per hour on the vertical timeline(24h → 1056px 内容高)。 */
const HOUR_PX = 44
/** 左侧小时刻度列宽。 */
const RAIL_PX = 44
/** 忙闲列最小宽(群聊列多时横向滚动)。 */
const COL_MIN_PX = 72
/** 群成员上限:attendee_ids 走 query string,资源与 URL 双重考虑截断。 */
const MAX_PEOPLE = 50
/** 冲突提示里最多列几个名字(超出补「等」;列头红点仍标出每一个人)。 */
const CONFLICT_NAMES_SHOWN = 3

/**
 * 忙闲块的外观:**左侧实心竖条 + 同色系浅底 + 同色深档文字** —— 与 App 的
 * TimeGrid / 主日历网格(calendarGridOverrides.css 文件末尾那节)完全同一套
 * 三件套,色值也是同一份(改色请三处同步:这里、那份 CSS、RsvpVisuals.kt)。
 *
 * 未回复额外加斜纹 + 虚线框(飞书同款「还没定」),一眼能和已接受的实心块分
 * 开 —— 这类冲突是软的。declined 不会来自 freebusy(后端按 rsvp≠declined 过
 * 滤),是从我自己的日程反推补上的,见 declinedBlocksOf。
 * null(无权看内容)= 中性灰实心、**不挂竖条**:与 App 一致,没内容就别摆出
 * 一副「有内容」的样子。
 */
const busyBlockSkin = (rsvp: RSVPStatus | null): React.CSSProperties => {
  if (rsvp === 'declined') {
    // 已拒绝:灰竖条 + 灰底 + 删除线,明确「这人不来」——和「压根没被邀请」
    // 的空白区分开(组织者最关心逐人回复)。
    return {
      backgroundColor: 'rgba(156,163,175,0.16)',
      borderLeft: '3px solid #9ca3af',
      color: '#6b7280',
      textDecoration: 'line-through',
    }
  }
  if (rsvp === 'needs_action') {
    return {
      backgroundColor: 'rgba(139,92,246,0.12)',
      backgroundImage:
        'repeating-linear-gradient(45deg, rgba(139,92,246,0.28) 0, rgba(139,92,246,0.28) 1.5px, transparent 1.5px, transparent 7px)',
      // 虚线框先给四边,再让左边被 3px 实心竖条盖掉(顺序即优先级)。
      border: '1px dashed rgba(139,92,246,0.75)',
      borderLeft: '3px solid #8b5cf6',
      color: '#5b21b6',
    }
  }
  if (rsvp === 'tentative') {
    return {
      backgroundColor: 'rgba(245,158,11,0.14)',
      borderLeft: '3px solid #f59e0b',
      color: '#92400e',
    }
  }
  if (rsvp === 'accepted') {
    return {
      backgroundColor: 'rgba(51,112,255,0.12)',
      borderLeft: '3px solid #3370ff',
      color: '#1e4db3',
    }
  }
  // 无权看内容:中性灰 + 灰字时段(块够高时),内容一个字不给。
  return { backgroundColor: '#d1d5db', color: '#4b5563' }
}

/** 忙碌块 / 已拒绝块共用的定位与排版(颜色交给 busyBlockSkin)。 */
const busyBlockClass = css({
  position: 'absolute',
  left: '2px',
  right: '2px',
  // 4px:与主日历网格的 .rbc-event / App 的 RoundedCornerShape(4.dp) 一致。
  borderRadius: '4px',
  overflow: 'hidden',
  paddingX: '3px',
  fontSize: '0.625rem',
  lineHeight: 1.4,
  pointerEvents: 'none',
})

const pad = (n: number) => String(n).padStart(2, '0')
const fmtMin = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`
const snapFloor = (min: number) => Math.floor(min / 30) * 30
const snapCeil = (min: number) => Math.ceil(min / 30) * 30
/** 选段微调粒度:与日历模块的抓手一致取 15min(初次拖选仍是 30min 格)。 */
const SNAP_MIN = 15
const snapStep = (min: number) => Math.round(min / SNAP_MIN) * SNAP_MIN
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

/**
 * P8 会话日历抽屉(私聊「查看日历」/ 群聊「群成员日历」,对标飞书):
 * 纵向时间轴一人一列展示当日忙闲(freebusy,只有区间没有标题),拖/点空白
 * 时段直接预填创建日程,底部实时判定「所有参与者都有空」,并给出全员空闲
 * 的建议时段。创建成功后向本会话发送 event-card 日程卡片。
 *
 * 跨组织/未激活成员 resolve 不出 we-meet id → 不渲染列、不参与判定、不预
 * 选参会,仅以计数提示,绝不静默少列(防「全员有空」误判)。
 */
export const ConversationCalendarPanel = ({
  client,
  conversation,
  currentUserUID,
  onClose,
}: Props) => {
  const { t, i18n } = useTranslation('im')
  const { alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()
  const cid = conversation.cid
  const isGroup = conversation.type === 'group'

  // ── 成员解析(与 ChatPane 完全同 key → 命中缓存零额外请求) ──
  const memberUids = conversation.members
  const { data: names = {}, isLoading: namesLoading } = useQuery({
    queryKey: ['im', 'member-names', memberUids],
    queryFn: () => resolveImUsers(memberUids),
    enabled: memberUids.length > 0,
    staleTime: 60_000,
  })
  const { people, unresolvedCount, capped } = useMemo(() => {
    const resolved = memberUids
      .filter((uid) => names[uid])
      .map((uid) => ({
        uid,
        id: names[uid].id,
        label: names[uid].full_name || names[uid].short_name || uid,
        avatar: names[uid].avatar_url || undefined,
      }))
    // 自己排第一列(飞书样式)。
    resolved.sort((a, b) =>
      a.uid === currentUserUID ? -1 : b.uid === currentUserUID ? 1 : 0
    )
    return {
      people: resolved.slice(0, MAX_PEOPLE),
      unresolvedCount: memberUids.length - resolved.length,
      capped: resolved.length > MAX_PEOPLE,
    }
  }, [memberUids, names, currentUserUID])

  // ── 选择成员(飞书:默认全选,「我」恒选;null = 全选) ──
  const [checked, setChecked] = useState<Set<string> | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const activePeople = useMemo(
    () => (checked ? people.filter((p) => checked.has(p.id)) : people),
    [people, checked]
  )

  // ── 日期导航(单日窗口,远小于 freebusy 的 31 天上限) ──
  const [day, setDay] = useState(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  })
  // 日期标题下拉的小月历(对齐飞书,点标题展开选日期)。
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const dayEnd = useMemo(() => {
    const d = new Date(day)
    d.setDate(d.getDate() + 1)
    return d
  }, [day])
  const dayKey = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
  const isToday =
    dayKey ===
    (() => {
      const n = new Date()
      return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
    })()
  const shiftDay = (delta: number) =>
    setDay((prev) => {
      const d = new Date(prev)
      d.setDate(d.getDate() + delta)
      return d
    })

  const ids = useMemo(
    () => activePeople.map((p) => p.id).sort(),
    [activePeople]
  )
  const { data: entries = [] } = useQuery({
    queryKey: ['im', 'freebusy', cid, dayKey, ids],
    queryFn: () => fetchFreeBusy(ids, day.toISOString(), dayEnd.toISOString()),
    enabled: ids.length > 0,
    staleTime: 30_000,
  })
  // ── 我当日的日程(我组织的 + 我参加的)。freebusy 只给区间不给标题(刻意
  // 不泄露他人日程内容),但**我自己有权看到的这些**可以贴回去:自己列显示
  // 标题,他人列显示「他对我这场会的回复状态」——后者在日程详情里本来就能
  // 看到,不是新增泄露。拉失败退回纯灰块,不影响忙闲主流程。 ──
  const { data: myEvents = [] } = useQuery({
    queryKey: ['im', 'my-events', dayKey],
    queryFn: () =>
      fetchCalendarEvents({
        start: day.toISOString(),
        end: dayEnd.toISOString(),
      }),
    staleTime: 30_000,
  })
  /**
   * 起止(当日分钟)完全一致才算同一场:后端的 busy 只合并重叠区间、首尾相接
   * 保留边界,所以不重叠时对得上;真重叠了就对不上 → 退回灰块,宁可不显示也
   * 不猜错。
   */
  const myEventAt = (startMin: number, endMin: number) =>
    myEvents.find((ev) => {
      const s = Math.round(
        (new Date(ev.start_at).getTime() - day.getTime()) / 60_000
      )
      const e = Math.round(
        (new Date(ev.end_at).getTime() - day.getTime()) / 60_000
      )
      return clamp(s, 0, 1440) === startMin && clamp(e, 0, 1440) === endMin
    })
  /** 这个人对这场会的回复状态;不在参与者(也非组织者)里 → null = 只画灰块。 */
  const rsvpOf = (ev: CalendarEvent, userId: string): RSVPStatus | null => {
    if (names[currentUserUID]?.id === userId) return ev.my_rsvp ?? 'accepted'
    const attendee = ev.attendees.find((a) => a.id === userId)
    if (attendee) return attendee.rsvp
    return ev.organizer?.id === userId ? 'accepted' : null
  }

  /**
   * 「他拒了我这场会」的块。拒绝的日程**不在 freebusy 里**(后端按 rsvp≠declined
   * 过滤 —— 拒了就不占他的时间,这是对的),所以只能从我自己的日程反推。不补的
   * 话「已拒绝」和「新入群、压根没被邀请」在组织者眼里都是一片空白,分不开。
   * 纯展示:不进 peopleBusy,不参与冲突判定,也不阻塞建议时段。
   * 全天日程会铺满整列遮住忙闲、已取消的会「谁拒了」也没意义,两者都不画。
   */
  const declinedBlocksOf = (userId: string, isSelf: boolean) =>
    myEvents
      .filter((ev) => {
        if (ev.all_day || ev.status?.toLowerCase() === 'cancelled') return false
        return isSelf
          ? ev.my_rsvp === 'declined'
          : ev.attendees.find((a) => a.id === userId)?.rsvp === 'declined'
      })
      .map((ev) => ({
        id: ev.id,
        title: ev.title,
        startMin: clamp(
          (new Date(ev.start_at).getTime() - day.getTime()) / 60_000,
          0,
          1440
        ),
        endMin: clamp(
          (new Date(ev.end_at).getTime() - day.getTime()) / 60_000,
          0,
          1440
        ),
      }))
      .filter((b) => b.endMin > b.startMin)

  const busyOf = (id: string) =>
    entries.find((e) => e.user_id === id)?.busy ?? []
  const peopleBusy = useMemo(
    () => activePeople.map((p) => ({ id: p.id, busy: busyOf(p.id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePeople, entries]
  )

  // ── 时段选择(30min 吸附落段;单击用「日程默认时长」,拖动用拖出的区间;
  // 选完可拖框移位 / 拖抓手改起止,15min 吸附) ──
  const { defaultDurationMin } = useCalendarSettings()
  const [sel, setSel] = useState<{ startMin: number; endMin: number } | null>(
    null
  )
  const dragAnchor = useRef<number | null>(null)
  const minutesOfEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return clamp(((e.clientY - rect.top) / HOUR_PX) * 60, 0, 1440)
  }
  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const min = snapFloor(minutesOfEvent(e))
    dragAnchor.current = min
    // 单击 = 按「日程默认时长」落段(与日历模块 / App 端一致);拖动则以
    // 拖出的区间为准(onGridMove 覆盖)。
    setSel({
      startMin: Math.min(min, 1440 - defaultDurationMin),
      endMin: Math.min(min + defaultDurationMin, 1440),
    })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const anchor = dragAnchor.current
    if (anchor === null) return
    const cur = minutesOfEvent(e)
    setSel({
      startMin: Math.min(anchor, snapFloor(cur)),
      endMin: clamp(Math.max(anchor + 30, snapCeil(cur)), 30, 1440),
    })
  }
  const onGridUp = () => {
    dragAnchor.current = null
  }

  /**
   * 选段的整体移位 / 拖抓手改起止(对齐 App 端与日历模块:15min 吸附)。
   * pointerdown 挂在选段与抓手上并 stopPropagation —— 否则会被下面网格的
   * onGridDown 当成「重新拖选」;move/up 挂 window,免得手指滑出抓手就断。
   */
  const dragSel = useRef<
    | { mode: 'move'; grabMin: number; duration: number }
    | { mode: 'start' | 'end' }
    | null
  >(null)
  const gridBodyRef = useRef<HTMLDivElement>(null)
  // window 监听里要读最新选段,又不想每帧重绑监听 → 用 ref 兜住。
  const selRef = useRef(sel)
  selRef.current = sel
  const minuteAtClientY = (clientY: number): number | null => {
    const grid = gridBodyRef.current
    if (!grid) return null
    const rect = grid.getBoundingClientRect()
    return clamp(((clientY - rect.top) / HOUR_PX) * 60, 0, 1440)
  }
  const onSelDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = selRef.current
    if (e.button !== 0 || !cur) return
    e.stopPropagation()
    const min = minuteAtClientY(e.clientY)
    if (min === null) return
    dragSel.current = {
      mode: 'move',
      grabMin: min - cur.startMin,
      duration: cur.endMin - cur.startMin,
    }
  }
  const onEdgeDown =
    (mode: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      dragSel.current = { mode }
    }
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = dragSel.current
      const cur = selRef.current
      if (!drag || !cur) return
      const min = minuteAtClientY(ev.clientY)
      if (min === null) return
      if (drag.mode === 'move') {
        const start = clamp(
          snapStep(min - drag.grabMin),
          0,
          1440 - drag.duration
        )
        setSel({ startMin: start, endMin: start + drag.duration })
        return
      }
      const snapped = snapStep(min)
      if (drag.mode === 'start') {
        setSel({
          startMin: clamp(snapped, 0, cur.endMin - SNAP_MIN),
          endMin: cur.endMin,
        })
      } else {
        setSel({
          startMin: cur.startMin,
          endMin: clamp(snapped, cur.startMin + SNAP_MIN, 1440),
        })
      }
    }
    const onUp = () => {
      dragSel.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])
  // 切日期后清掉旧选择(时段是相对当日的)。
  useEffect(() => setSel(null), [dayKey])

  const selStart = sel ? new Date(day.getTime() + sel.startMin * 60_000) : null
  const selEnd = sel ? new Date(day.getTime() + sel.endMin * 60_000) : null
  const busyIds =
    sel && selStart && selEnd
      ? busyPeopleInRange(peopleBusy, selStart, selEnd)
      : []
  const busyNames = activePeople
    .filter((p) => busyIds.includes(p.id))
    .map((p) => p.label)

  // ── 建议时段(全员空闲;entries 未回来前不显示) ──
  const suggestions: SuggestedSlot[] = useMemo(
    () =>
      activePeople.length > 1 && entries.length > 0
        ? suggestCommonSlots(peopleBusy, day, {
            durationMin: defaultDurationMin,
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peopleBusy, dayKey, defaultDurationMin]
  )
  const pickSuggestion = (s: SuggestedSlot) =>
    setSel({
      startMin: (s.start.getTime() - day.getTime()) / 60_000,
      endMin: (s.end.getTime() - day.getTime()) / 60_000,
    })

  // 初次打开滚动到 09:00(工作时间开头)。
  const vscrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    vscrollRef.current?.scrollTo({ top: 9 * HOUR_PX - 8 })
  }, [])

  // ── 创建日程 ──
  const [dialogOpen, setDialogOpen] = useState(false)
  const initialSelected = useMemo(
    () =>
      new Map(
        activePeople
          .filter((p) => p.uid !== currentUserUID)
          .map((p) => [p.id, p.label] as [string, string])
      ),
    [activePeople, currentUserUID]
  )

  const nowMin = (() => {
    const n = new Date()
    return n.getHours() * 60 + n.getMinutes()
  })()

  return (
    <aside
      aria-label={isGroup ? t('calendar.groupOpen') : t('calendar.open')}
      data-testid="conversation-calendar-panel"
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        // P8-UX:宽度由外层 ResizablePanel(side=right)拖拽控制。
        width: '100%',
        height: '100%',
        backgroundColor: 'greyscale.000',
        borderLeft: '1px solid token(colors.greyscale.200)',
        overflow: 'hidden',
        animation: 'fade 150ms ease-out',
      })}
    >
      {/* Header */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {isGroup ? t('calendar.groupOpen') : t('calendar.open')}
        </h2>
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
          })}
        >
          {/* P8-UX:选择成员(飞书右上角入口) */}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title={t('calendar.picker.title')}
            aria-label={t('calendar.picker.title')}
            data-testid="freebusy-pick-members"
            className={css({
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'greyscale.600',
              display: 'flex',
              _hover: { color: 'primary.600' },
            })}
          >
            <RiUserFollowLine size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('manage.cancel')}
            className={css({
              border: 'none',
              background: 'transparent',
              fontSize: '1.25rem',
              lineHeight: 1,
              cursor: 'pointer',
              color: 'greyscale.600',
            })}
          >
            ×
          </button>
        </div>
      </div>

      {/* 日期条 */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          paddingX: '0.75rem',
          paddingY: '0.5rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <Button
          variant="quaternaryText"
          size="icon24"
          className={navGlyphCls}
          onPress={() => shiftDay(-1)}
          aria-label={t('calendar.prevDay')}
        >
          ‹
        </Button>
        <button
          type="button"
          onClick={() => {
            const d = new Date()
            d.setHours(0, 0, 0, 0)
            setDay(d)
          }}
          className={css({
            paddingX: '0.5rem',
            paddingY: '0.25rem',
            border: 'none',
            borderRadius: '0.375rem',
            background: 'transparent',
            fontSize: '0.75rem',
            cursor: 'pointer',
            color: isToday ? 'primary.600' : 'greyscale.700',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          {t('calendar.today')}
        </button>
        <Button
          variant="quaternaryText"
          size="icon24"
          className={navGlyphCls}
          onPress={() => shiftDay(1)}
          aria-label={t('calendar.nextDay')}
        >
          ›
        </Button>
        <div className={css({ position: 'relative' })}>
          <button
            type="button"
            onClick={() => setDatePickerOpen((v) => !v)}
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              border: 'none',
              borderRadius: '0.375rem',
              background: 'transparent',
              paddingX: '0.375rem',
              paddingY: '0.25rem',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              color: 'greyscale.900',
              cursor: 'pointer',
              _hover: { backgroundColor: 'greyscale.100' },
            })}
          >
            {i18n.language.startsWith('zh')
              ? `${day.toLocaleDateString(i18n.language, {
                  month: 'long',
                  day: 'numeric',
                })} ${day.toLocaleDateString(i18n.language, { weekday: 'short' })}`
              : day.toLocaleDateString(i18n.language, {
                  month: 'long',
                  day: 'numeric',
                  weekday: 'short',
                })}
            <span
              aria-hidden
              className={css({ fontSize: '0.625rem', color: 'greyscale.500' })}
            >
              {datePickerOpen ? '▲' : '▼'}
            </span>
          </button>
          {datePickerOpen && (
            <>
              {/* 点击外部关闭 */}
              <div
                className={css({ position: 'fixed', inset: 0, zIndex: 20 })}
                onClick={() => setDatePickerOpen(false)}
              />
              <div
                className={css({
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  zIndex: 21,
                  width: '16.5rem',
                  padding: '0.75rem',
                  backgroundColor: 'greyscale.000',
                  border: '1px solid token(colors.greyscale.200)',
                  borderRadius: '0.5rem',
                  boxShadow: 'overlay',
                })}
              >
                <MiniCalendar
                  value={day}
                  onChange={(d) => {
                    const nd = new Date(d)
                    nd.setHours(0, 0, 0, 0)
                    setDay(nd)
                    setDatePickerOpen(false)
                  }}
                  events={[]}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {namesLoading ? (
        <div className={hintCls}>{t('chat.loading')}</div>
      ) : people.length === 0 ? (
        <div className={hintCls}>
          {t('calendar.unresolved', { count: unresolvedCount })}
        </div>
      ) : (
        <div
          ref={vscrollRef}
          className={css({
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
          })}
        >
          {/* 单一滚动容器(修复双横滚条):宽度包住内容,列多时超出视口 →
              只有这一根横滚条,列头/刻度用 sticky 钉住;少列时铺满面板宽。 */}
          <div className={css({ minWidth: '100%', width: 'max-content' })}>
            {/* 列头 sticky 顶:竖滚钉住,横滚随列一起走(与网格严格对齐) */}
            <div
              className={css({
                display: 'flex',
                position: 'sticky',
                top: 0,
                zIndex: 2,
                backgroundColor: 'greyscale.000',
                paddingY: '0.375rem',
              })}
            >
              <div
                className={css({
                  position: 'sticky',
                  left: 0,
                  zIndex: 3,
                  backgroundColor: 'greyscale.000',
                })}
                style={{ width: RAIL_PX, flexShrink: 0 }}
              />
              {activePeople.map((p) => (
                <div
                  key={p.id}
                  className={css({
                    flex: '1 0 auto',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.25rem',
                    paddingX: '0.25rem',
                  })}
                  style={{ minWidth: COL_MIN_PX, width: COL_MIN_PX }}
                >
                  <Avatar name={p.label} src={p.avatar} size="1.75rem" />
                  <span
                    className={css({
                      maxWidth: '100%',
                      fontSize: '0.6875rem',
                      color: 'greyscale.700',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    })}
                  >
                    {p.label}
                  </span>
                </div>
              ))}
            </div>

            {/* 时间轴主体 */}
            <div
              className={css({ display: 'flex', position: 'relative' })}
              style={{ height: 24 * HOUR_PX }}
            >
              {/* 小时刻度列 sticky 左:横滚时钉在左缘 */}
              <div
                className={css({
                  position: 'sticky',
                  left: 0,
                  zIndex: 1,
                  backgroundColor: 'greyscale.000',
                })}
                style={{ width: RAIL_PX, flexShrink: 0 }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className={css({
                      fontSize: '0.625rem',
                      color: 'greyscale.500',
                      textAlign: 'right',
                      paddingRight: '0.25rem',
                    })}
                    style={{ height: HOUR_PX }}
                  >
                    {pad(h)}:00
                  </div>
                ))}
              </div>

              {/* 忙闲列区(拖/点选挂在这层) */}
              <div
                data-testid="freebusy-grid"
                ref={gridBodyRef}
                onPointerDown={onGridDown}
                onPointerMove={onGridMove}
                onPointerUp={onGridUp}
                className={css({
                  position: 'relative',
                  display: 'flex',
                  flex: '1 0 auto',
                  cursor: 'crosshair',
                  touchAction: 'none',
                })}
                style={{
                  backgroundImage: `repeating-linear-gradient(to bottom, #eef0f2 0, #eef0f2 1px, transparent 1px, transparent ${HOUR_PX}px)`,
                }}
              >
                {/* 工作时间以外置灰 */}
                <div
                  className={workShade}
                  style={{ top: 0, height: 9 * HOUR_PX }}
                />
                <div
                  className={workShade}
                  style={{ top: 18 * HOUR_PX, height: 6 * HOUR_PX }}
                />
                {activePeople.map((p) => (
                  <div
                    key={p.id}
                    className={css({
                      position: 'relative',
                      flex: '1 0 auto',
                      borderLeft: '1px solid token(colors.greyscale.100)',
                    })}
                    style={{ minWidth: COL_MIN_PX, width: COL_MIN_PX }}
                  >
                    {/* 「已拒绝」块:先渲染 → 真忙碌的块叠在它上面(万一那个
                        点他另有安排)。 */}
                    {declinedBlocksOf(
                      p.id,
                      names[currentUserUID]?.id === p.id
                    ).map((b) => {
                      const time = `${fmtMin(Math.round(b.startMin))}–${fmtMin(
                        Math.round(b.endMin)
                      )}`
                      // 他人列写状态(组织者要的就是「这人拒了」);自己列写标题
                      // —— 自己拒过的会,认得标题比看到「已拒绝」有用。
                      const text =
                        names[currentUserUID]?.id === p.id
                          ? b.title || t('calendar.untitled')
                          : t('calendar.rsvpDeclined')
                      return (
                        <div
                          key={`declined-${b.id}`}
                          title={`${text} · ${time}`}
                          className={busyBlockClass}
                          style={{
                            top: (b.startMin / 60) * HOUR_PX + 0.5,
                            height: Math.max(
                              ((b.endMin - b.startMin) / 60) * HOUR_PX - 1,
                              3
                            ),
                            ...busyBlockSkin('declined'),
                          }}
                        >
                          {(b.endMin - b.startMin) * (HOUR_PX / 60) >= 18
                            ? text
                            : null}
                        </div>
                      )
                    })}
                    {busyOf(p.id).map((b, i) => {
                      const s = clamp(
                        (new Date(b.start).getTime() - day.getTime()) / 60_000,
                        0,
                        1440
                      )
                      const e = clamp(
                        (new Date(b.end).getTime() - day.getTime()) / 60_000,
                        0,
                        1440
                      )
                      if (e <= s) return null
                      const time = `${fmtMin(Math.round(s))}–${fmtMin(Math.round(e))}`
                      // 对得上「我的一场会」→ 贴标题 + 该人的回复状态;对不上
                      // (他自己的别的日程)→ 保持纯灰块,只有 hover 时段提示。
                      const mine = myEventAt(Math.round(s), Math.round(e))
                      const rsvp = mine ? rsvpOf(mine, p.id) : null
                      const skin = busyBlockSkin(rsvp)
                      // 他人未回复 → 写「未回复」(我关心的是这冲突是软的);
                      // 自己列照常写标题,未回复由斜纹表达就够。
                      const isSelf = names[currentUserUID]?.id === p.id
                      const text = !rsvp
                        ? null
                        : rsvp === 'needs_action' && !isSelf
                          ? t('calendar.rsvpPending')
                          : mine?.title || t('calendar.untitled')
                      return (
                        <div
                          key={i}
                          title={text ? `${text} · ${time}` : time}
                          className={busyBlockClass}
                          style={{
                            // 上下各让 0.5px:首尾相接的两个日程之间露出
                            // 1px 白缝,肉眼可辨是两块(后端已改为相接不合并)。
                            top: (s / 60) * HOUR_PX + 0.5,
                            height: Math.max(((e - s) / 60) * HOUR_PX - 1, 3),
                            ...skin,
                          }}
                        >
                          {/* 块高不够就不塞字,免得半行字被裁 */}
                          {(e - s) * (HOUR_PX / 60) >= 18
                            ? (text ?? time)
                            : null}
                        </div>
                      )
                    })}
                  </div>
                ))}

                {/* 当前时刻红线(仅今天) */}
                {isToday && (
                  <div
                    className={css({
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      height: '2px',
                      backgroundColor: '#ef4444',
                      pointerEvents: 'none',
                    })}
                    style={{ top: (nowMin / 60) * HOUR_PX }}
                  />
                )}

                {/* 选中时段横贯高亮:框本体可整体拖动移位,上右/左下两个圆抓手
                    改起止(与日历模块的预选框同一套手势与长相)。 */}
                {sel && (
                  <div
                    data-testid="freebusy-selection"
                    onPointerDown={onSelDown}
                    className={css({
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      border: '1.5px solid token(colors.primary.500)',
                      borderRadius: '4px',
                      cursor: 'move',
                      touchAction: 'none',
                    })}
                    style={{
                      top: (sel.startMin / 60) * HOUR_PX,
                      height: ((sel.endMin - sel.startMin) / 60) * HOUR_PX,
                      borderColor:
                        busyIds.length > 0 ? '#dc2626' : undefined,
                      backgroundColor:
                        busyIds.length > 0
                          ? 'rgba(220,38,38,0.18)'
                          : 'rgba(59,130,246,0.18)',
                    }}
                  >
                    <SelectionHandle
                      edge="start"
                      conflict={busyIds.length > 0}
                      onPointerDown={onEdgeDown('start')}
                    />
                    <SelectionHandle
                      edge="end"
                      conflict={busyIds.length > 0}
                      onPointerDown={onEdgeDown('end')}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 建议时段 chips */}
      {suggestions.length > 0 && (
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.375rem',
            paddingX: '0.75rem',
            paddingY: '0.5rem',
            borderTop: '1px solid token(colors.greyscale.200)',
          })}
        >
          <span
            className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
          >
            {t('calendar.suggestTitle')}
          </span>
          {suggestions.map((s) => (
            <button
              key={s.start.getTime()}
              type="button"
              onClick={() => pickSuggestion(s)}
              className={css({
                paddingX: '0.5rem',
                paddingY: '0.25rem',
                border: '1px solid token(colors.brand.300)',
                borderRadius: '999px',
                backgroundColor: 'brand.50',
                color: 'brand.700',
                fontSize: '0.75rem',
                cursor: 'pointer',
                _hover: { backgroundColor: 'brand.100' },
              })}
            >
              {`${fmtMin((s.start.getTime() - day.getTime()) / 60_000)}-${fmtMin((s.end.getTime() - day.getTime()) / 60_000)}`}
            </button>
          ))}
        </div>
      )}

      {/* 底部:所选时段 + 空闲判定 + 创建 */}
      <div
        className={css({
          paddingX: '0.75rem',
          paddingY: '0.625rem',
          borderTop: '1px solid token(colors.greyscale.200)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.375rem',
        })}
      >
        {sel ? (
          <>
            <div
              className={css({
                fontSize: '0.875rem',
                fontWeight: 'medium',
                color: 'greyscale.900',
              })}
            >
              {`${fmtMin(sel.startMin)} - ${fmtMin(sel.endMin)}`}
              <span
                className={css({
                  marginLeft: '0.5rem',
                  fontSize: '0.75rem',
                  fontWeight: 'normal',
                })}
                style={{ color: busyIds.length > 0 ? '#d97706' : '#16a34a' }}
                data-testid="freebusy-verdict"
              >
                {busyIds.length > 0
                  ? t(
                      // 名字列不下就截断,但**必须带「等」** —— 只截名字不改
                      // 文案的话,「6 人忙碌:三个名字」看着像漏了人。
                      busyNames.length > CONFLICT_NAMES_SHOWN
                        ? 'calendar.someBusyMore'
                        : 'calendar.someBusy',
                      {
                        count: busyNames.length,
                        names: busyNames
                          .slice(0, CONFLICT_NAMES_SHOWN)
                          .join('、'),
                      }
                    )
                  : t('calendar.allFree')}
              </span>
            </div>
          </>
        ) : (
          <div className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>
            {t('calendar.pickHint')}
          </div>
        )}
        {(unresolvedCount > 0 || capped) && (
          <div
            className={css({ fontSize: '0.6875rem', color: 'greyscale.500' })}
          >
            {unresolvedCount > 0 &&
              t('calendar.unresolved', { count: unresolvedCount })}
            {capped && ` ${t('calendar.membersCapped', { count: MAX_PEOPLE })}`}
          </div>
        )}
        <Button
          variant="primary"
          size="action"
          isDisabled={!sel}
          onPress={() => setDialogOpen(true)}
          data-testid="freebusy-create"
          className={css({ width: '100%' })}
        >
          {t('calendar.create')}
        </Button>
      </div>

      {pickerOpen && (
        <MemberPicker
          people={people}
          selfUid={currentUserUID}
          initial={checked ?? new Set(people.map((p) => p.id))}
          onConfirm={(next) => {
            setChecked(next)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {dialogOpen && selStart && selEnd && (
        <CreateEventDialog
          initialStart={selStart}
          initialEnd={selEnd}
          initialSelected={initialSelected}
          sourceConversationId={cid}
          onClose={() => setDialogOpen(false)}
          onCreated={(event) => {
            setDialogOpen(false)
            void queryClient.invalidateQueries({ queryKey: ['calendar'] })
            void queryClient.invalidateQueries({
              queryKey: ['im', 'freebusy', cid],
            })
            // 创建卡只由客户端发(变更/取消卡由后端发,见 P8 设计)。发送失败
            // 不回滚日程 —— 日程本体是 source of truth,卡片只是投影。
            client
              .sendText(cid, buildEventCardBody(event), {
                contentType: 'event-card',
              })
              .catch(() => {
                void showAlert({ message: t('calendar.cardSendFailed') })
              })
          }}
        />
      )}
    </aside>
  )
}

/**
 * P8-UX 选择成员弹窗(飞书样式):圆形勾选列表 + 搜索 + 底部「已选 N 人 +
 * 确定」。「我」恒选不可取消(发起人必参加);确定后忙闲列/建议/预填参会
 * 全部按勾选集过滤。
 */
const MemberPicker = ({
  people,
  selfUid,
  initial,
  onConfirm,
  onClose,
}: {
  people: { uid: string; id: string; label: string; avatar?: string }[]
  selfUid: string
  initial: Set<string>
  onConfirm: (next: Set<string>) => void
  onClose: () => void
}) => {
  const { t } = useTranslation('im')
  const [temp, setTemp] = useState<Set<string>>(() => new Set(initial))
  const [query, setQuery] = useState('')
  const shown = query.trim()
    ? people.filter((p) =>
        p.label.toLowerCase().includes(query.trim().toLowerCase())
      )
    : people

  const toggle = (p: { uid: string; id: string }) => {
    if (p.uid === selfUid) return
    setTemp((prev) => {
      const next = new Set(prev)
      if (next.has(p.id)) next.delete(p.id)
      else next.add(p.id)
      return next
    })
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('calendar.picker.title')}
      maxWidth="380px"
    >
      <div
        className={css({
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
          fontSize: '1rem',
          fontWeight: 'bold',
          color: 'greyscale.900',
        })}
      >
        {t('calendar.picker.title')}
      </div>
      <div className={css({ padding: '0.75rem 1rem 0' })}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('calendar.picker.search')}
          className={css({
            width: '100%',
            paddingX: '0.75rem',
            paddingY: '0.5rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            outline: 'none',
            _focus: { borderColor: 'primary.500' },
          })}
        />
      </div>
      <div
        className={css({
          maxHeight: '320px',
          overflowY: 'auto',
          padding: '0.5rem 0',
        })}
      >
        {shown.map((p) => {
          const isSelf = p.uid === selfUid
          const isChecked = temp.has(p.id)
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p)}
              disabled={isSelf}
              data-testid={`freebusy-picker-${p.id}`}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.625rem',
                width: '100%',
                paddingX: '1rem',
                paddingY: '0.5rem',
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
                _disabled: { cursor: 'default' },
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              <span
                aria-hidden="true"
                className={css({
                  flexShrink: 0,
                  width: '1.125rem',
                  height: '1.125rem',
                  borderRadius: '999px',
                  border: '1px solid token(colors.greyscale.400)',
                  color: 'white',
                  fontSize: '0.75rem',
                  lineHeight: '1.125rem',
                  textAlign: 'center',
                })}
                style={{
                  backgroundColor: isChecked
                    ? isSelf
                      ? 'rgba(59,130,246,0.5)'
                      : '#3b82f6'
                    : 'white',
                  borderColor: isChecked ? 'transparent' : undefined,
                }}
              >
                {isChecked ? '✓' : ''}
              </span>
              <Avatar name={p.label} src={p.avatar} size="1.75rem" />
              <span
                className={css({
                  minWidth: 0,
                  fontSize: '0.875rem',
                  color: 'greyscale.900',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                })}
              >
                {p.label}
              </span>
            </button>
          )
        })}
      </div>
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderTop: '1px solid token(colors.greyscale.200)',
        })}
      >
        <span
          className={css({
            flex: 1,
            fontSize: '0.8125rem',
            color: 'primary.600',
          })}
        >
          {t('calendar.picker.selected', { count: temp.size })}
        </span>
        <Button
          variant="primary"
          size="action"
          onPress={() => onConfirm(temp)}
          data-testid="freebusy-picker-confirm"
        >
          {t('calendar.picker.confirm')}
        </Button>
      </div>
    </Modal>
  )
}

const hintCls = css({
  padding: '1rem',
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})
const workShade = css({
  position: 'absolute',
  left: 0,
  right: 0,
  backgroundColor: 'rgba(0,0,0,0.03)',
  pointerEvents: 'none',
})

/**
 * 选段的上下边界抓手:白心主色圈的小圆点,骑在边界线上(上→右上、下→左下),
 * 与日历模块 / App 端同一长相。外层 27px 透明方块只为放大热区。
 */
const SelectionHandle = ({
  edge,
  conflict,
  onPointerDown,
}: {
  edge: 'start' | 'end'
  conflict: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) => (
  <div
    data-testid={`freebusy-handle-${edge}`}
    onPointerDown={onPointerDown}
    className={css({
      position: 'absolute',
      width: '27px',
      height: '27px',
      display: 'grid',
      placeItems: 'center',
      cursor: 'ns-resize',
      touchAction: 'none',
      zIndex: 2,
    })}
    style={
      edge === 'start'
        ? { top: '-13.5px', right: '4px' }
        : { bottom: '-13.5px', left: '4px' }
    }
  >
    <div
      className={css({
        width: '13px',
        height: '13px',
        borderRadius: '50%',
        backgroundColor: 'white',
        border: '2px solid token(colors.primary.500)',
      })}
      style={conflict ? { borderColor: '#dc2626' } : undefined}
    />
  </div>
)
