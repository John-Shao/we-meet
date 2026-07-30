import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiUserFollowLine } from '@remixicon/react'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
import {
  CreateEventDialog,
  MiniCalendar,
  fetchFreeBusy,
  busyPeopleInRange,
  suggestCommonSlots,
  useCalendarSettings,
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
        <button
          type="button"
          onClick={() => shiftDay(-1)}
          aria-label={t('calendar.prevDay')}
          className={navBtn}
        >
          ‹
        </button>
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
        <button
          type="button"
          onClick={() => shiftDay(1)}
          aria-label={t('calendar.nextDay')}
          className={navBtn}
        >
          ›
        </button>
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
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
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
                      return (
                        <div
                          key={i}
                          title={`${fmtMin(Math.round(s))}–${fmtMin(Math.round(e))}`}
                          className={css({
                            position: 'absolute',
                            left: '2px',
                            right: '2px',
                            borderRadius: '3px',
                            backgroundColor: 'greyscale.300',
                            pointerEvents: 'none',
                          })}
                          style={{
                            // 上下各让 0.5px:首尾相接的两个日程之间露出
                            // 1px 白缝,肉眼可辨是两块(后端已改为相接不合并)。
                            top: (s / 60) * HOUR_PX + 0.5,
                            height: Math.max(((e - s) / 60) * HOUR_PX - 1, 3),
                          }}
                        />
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
                border: '1px solid token(colors.primary.300)',
                borderRadius: '999px',
                backgroundColor: 'primary.50',
                color: 'primary.700',
                fontSize: '0.75rem',
                cursor: 'pointer',
                _hover: { backgroundColor: 'primary.100' },
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
                  ? t('calendar.someBusy', {
                      count: busyIds.length,
                      names: busyNames.slice(0, 3).join('、'),
                    })
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
        <button
          type="button"
          disabled={!sel}
          onClick={() => setDialogOpen(true)}
          data-testid="freebusy-create"
          className={css({
            paddingY: '0.5rem',
            border: 'none',
            borderRadius: '0.5rem',
            backgroundColor: sel ? 'primary.500' : 'greyscale.300',
            color: 'white',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            cursor: sel ? 'pointer' : 'not-allowed',
          })}
        >
          {t('calendar.create')}
        </button>
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
        <button
          type="button"
          onClick={() => onConfirm(temp)}
          data-testid="freebusy-picker-confirm"
          className={css({
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
          {t('calendar.picker.confirm')}
        </button>
      </div>
    </Modal>
  )
}

const navBtn = css({
  width: '1.5rem',
  height: '1.5rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: '0.375rem',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.700',
  // ‹ › 字形本身偏小,小字号下只剩几个像素;跟日历工具栏同档用大字号。
  fontSize: '1.25rem',
  lineHeight: 1,
  _hover: { backgroundColor: 'greyscale.100' },
})
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
