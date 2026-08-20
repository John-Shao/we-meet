import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { MemberAvatar } from '@/features/contacts'

import { fetchFreeBusy } from '../api/fetchCalendar'
import { linkBtnCls } from '@/styles/controls'

import { labelCls } from './formStyles'
import { BulkAttendeeDialog } from './BulkAttendeeDialog'
import type { AttendeeRole } from '../api/ApiCalendar'
import {
  deviceTimezone,
  instantToZonedDate,
  zonedDateToInstant,
} from '../utils/zonedDate'

interface Props {
  /** 已选普通参与者 id → 显示名(组织者由 organizer 单独传入)。 */
  selected: Map<string, string>
  onToggle: (id: string, label: string) => void
  roles: Map<string, AttendeeRole>
  onRoleChange: (id: string, role: AttendeeRole) => void
  /** 预填参与者的头像(编辑态从事件带进来);选人面板选中的会自动补进缓存。 */
  initialAvatars?: Map<string, string>
  /** 所选时段 —— 用来给每位参与者标忙/闲;全天或时间未填时传 null。 */
  slotStart?: Date | null
  slotEnd?: Date | null
  /** Calendar/event timezone used to derive the busy-query civil day. */
  slotTimezone?: string
  /** 编辑态:忙闲里剔除当前日程自身,原参与者不被自己这场误报忙碌。 */
  excludeEventId?: string
  /** 当前用户 —— 仅在其不在参与者列表时显示自身冲突提示。 */
  selfId?: string
  /** 固定显示并计数的组织者；不进入普通参与者提交载荷。 */
  organizer?: {
    id: string
    label: string
    avatarUrl?: string
  } | null
}

/**
 * 参与者选取。
 *
 * 一行标题「参与者 (已选 N 人)」+ 右对齐的「添加参与者」文字按钮(与会议室
 *「添加会议室 / 更换」同款),下面是已选的人:一人一行,头像 + 名字 +
 * 忙/闲 + 行尾 × 移除。忙/闲取代了原先单独一块的忙闲时间条。
 *
 * 加人只有一条路径:「添加参与者」开 [BulkAttendeeDialog](复用 IM「新建群聊」的
 * 左搜索勾选 + 右已选面板)。原先并存的「行内搜索框 + 候选浮层」已去掉 ——
 * 两个入口做同一件事,行内那个还只能一次加一个人。
 */
export const AttendeePicker = ({
  selected,
  onToggle,
  roles,
  onRoleChange,
  initialAvatars,
  slotStart,
  slotEnd,
  slotTimezone = deviceTimezone(),
  excludeEventId,
  selfId,
  organizer,
}: Props) => {
  const { t } = useTranslation('calendar')
  const [bulkOpen, setBulkOpen] = useState(false)

  // 头像缓存:selected 只有 id→名字,渲染已选行时拿不到头像 URL(会退成字母
  // 色块)。编辑态由 props 预填,选人面板确定时把勾过的人一并带回来。
  const avatarsRef = useRef(new Map<string, string>())
  if (initialAvatars) {
    initialAvatars.forEach((url, id) => {
      if (url && !avatarsRef.current.has(id)) avatarsRef.current.set(id, url)
    })
  }

  // 忙闲:按「所选开始时刻当天」拉一次,判断每人在所选时段是否有冲突。
  // 只要状态(忙/闲),不画时间条。
  const dayStartWall = slotStart
    ? instantToZonedDate(slotStart, slotTimezone)
    : null
  dayStartWall?.setHours(0, 0, 0, 0)
  const dayEndWall = dayStartWall ? new Date(dayStartWall) : null
  dayEndWall?.setDate(dayEndWall.getDate() + 1)
  const dayStart = dayStartWall
    ? zonedDateToInstant(dayStartWall, slotTimezone)
    : null
  const dayEnd = dayEndWall
    ? zonedDateToInstant(dayEndWall, slotTimezone)
    : null
  const busyIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...selected.keys(),
          ...(organizer?.id ? [organizer.id] : []),
          ...(selfId ? [selfId] : []),
        ])
      ),
    [organizer?.id, selected, selfId]
  )
  const { data: entries = [] } = useQuery({
    /* eslint-disable @tanstack/query/exhaustive-deps */
    queryKey: [
      'calendar',
      'freebusy',
      busyIds.slice().sort().join(','),
      dayStart?.toISOString() ?? '',
      excludeEventId ?? '',
    ],
    /* eslint-enable @tanstack/query/exhaustive-deps */
    queryFn: () =>
      fetchFreeBusy(
        busyIds,
        dayStart!.toISOString(),
        dayEnd!.toISOString(),
        excludeEventId
      ),
    enabled: busyIds.length > 0 && !!dayStart && !!dayEnd,
    staleTime: 30_000,
  })
  const isBusy = (id: string) => {
    if (!slotStart || !slotEnd) return false
    return (entries.find((e) => e.user_id === id)?.busy ?? []).some(
      (b) => new Date(b.start) < slotEnd && new Date(b.end) > slotStart
    )
  }
  const showStatus = !!slotStart && !!slotEnd
  const participantCount = selected.size + (organizer ? 1 : 0)
  const selfIsListed =
    !!selfId && (selfId === organizer?.id || selected.has(selfId))

  return (
    <div>
      {/* 「参与者 (已选 N 人)」与「添加参与者」同一行 —— 与会议室
          「添加会议室 / 更换」同一款右对齐文字按钮。 */}
      <div className={headRowCls}>
        <span className={labelCls}>
          {t('form.attendees')} (
          {t('form.selected', { count: participantCount })})
        </span>
        <button
          type="button"
          onClick={() => setBulkOpen(true)}
          data-testid="event-attendee-add"
          className={linkBtnCls}
        >
          {t('form.bulkAdd')}
        </button>
      </div>

      {/* 组织者是固定参与者；普通参与者仍可修改角色或移除。 */}
      {(organizer || selected.size > 0) && (
        <ul className={pickedListCls} data-testid="attendee-picked">
          {organizer && (
            <li
              className={
                showStatus && isBusy(organizer.id)
                  ? pickedRowBusyCls
                  : pickedRowCls
              }
              data-testid="attendee-organizer"
            >
              <MemberAvatar
                name={organizer.label}
                src={organizer.avatarUrl}
                size="1.5rem"
              />
              <span
                className={
                  showStatus && isBusy(organizer.id)
                    ? pickedNameBusyCls
                    : pickedNameCls
                }
              >
                {organizer.label}
              </span>
              {showStatus && (
                <span
                  className={
                    isBusy(organizer.id) ? statusBusyCls : statusFreeCls
                  }
                  data-testid={`attendee-status-${organizer.id}`}
                >
                  {isBusy(organizer.id)
                    ? t('freebusy.busy')
                    : t('freebusy.free')}
                </span>
              )}
              <span className={organizerRoleCls}>{t('card.organizer')}</span>
            </li>
          )}
          {[...selected.entries()].map(([id, label]) => {
            const busy = showStatus && isBusy(id)
            return (
              <li key={id} className={busy ? pickedRowBusyCls : pickedRowCls}>
                <MemberAvatar
                  name={label}
                  src={avatarsRef.current.get(id)}
                  size="1.5rem"
                />
                <span className={busy ? pickedNameBusyCls : pickedNameCls}>
                  {label}
                </span>
                {showStatus && (
                  <span
                    className={busy ? statusBusyCls : statusFreeCls}
                    data-testid={`attendee-status-${id}`}
                  >
                    {busy ? t('freebusy.busy') : t('freebusy.free')}
                  </span>
                )}
                <select
                  value={roles.get(id) ?? 'required'}
                  onChange={(e) =>
                    onRoleChange(id, e.target.value as AttendeeRole)
                  }
                  aria-label={t('form.attendeeRole', { name: label })}
                  data-testid={`attendee-role-${id}`}
                  className={roleSelectCls}
                >
                  <option value="required">{t('form.required')}</option>
                  <option value="optional">{t('form.optional')}</option>
                </select>
                <button
                  type="button"
                  onClick={() => onToggle(id, label)}
                  aria-label={t('form.removeAttendee', { name: label })}
                  className={pickedRemoveCls}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* 当前用户不在参与者列表时，仍提醒其自身的时段冲突。 */}
      {showStatus && selfId && !selfIsListed && isBusy(selfId) && (
        <p className={selfBusyCls} data-testid="attendee-self-busy">
          {t('freebusy.selfBusy')}
        </p>
      )}

      {bulkOpen && (
        <BulkAttendeeDialog
          initial={selected}
          excludeIds={organizer ? new Set([organizer.id]) : undefined}
          onClose={() => setBulkOpen(false)}
          onConfirm={(next, avatars) => {
            avatars.forEach((url, id) => avatarsRef.current.set(id, url))
            // 父组件只给了 toggle,这里按差集逐个开合。toggle 走函数式
            // setState,同一个事件里连着调多次能正确累加。
            selected.forEach((label, id) => {
              if (!next.has(id)) onToggle(id, label)
            })
            next.forEach((label, id) => {
              if (!selected.has(id)) onToggle(id, label)
            })
            setBulkOpen(false)
          }}
        />
      )}
    </div>
  )
}

const headRowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
})

// 已选列表:人多了自己滚,不把对话框顶长。
const pickedListCls = css({
  listStyle: 'none',
  margin: '0.375rem 0 0',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  maxHeight: '11rem',
  overflowY: 'auto',
})

const pickedRowBase = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  borderRadius: '0.375rem',
} as const

// 忙/闲两个完整类整体切换,不 cx 叠加同属性(panda-cx-atomic-order-trap)。
const pickedRowCls = css({
  ...pickedRowBase,
  backgroundColor: 'greyscale.50',
})
const pickedRowBusyCls = css({
  ...pickedRowBase,
  backgroundColor: 'danger.50',
})

const pickedNameBase = {
  flex: 1,
  minWidth: 0,
  fontSize: '0.875rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const pickedNameCls = css({ ...pickedNameBase, color: 'greyscale.800' })
const pickedNameBusyCls = css({ ...pickedNameBase, color: 'danger.600' })

const statusBase = {
  flexShrink: 0,
  paddingX: '0.25rem',
  fontSize: '0.6875rem',
} as const

const statusBusyCls = css({ ...statusBase, color: 'danger.600' })
const statusFreeCls = css({ ...statusBase, color: 'greyscale.500' })

const roleSelectCls = css({
  flexShrink: 0,
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.000',
  paddingX: '0.375rem',
  paddingY: '0.125rem',
  fontSize: '0.75rem',
  color: 'greyscale.700',
  '& option': {
    backgroundColor: 'greyscale.000',
    color: 'greyscale.900',
  },
})

const organizerRoleCls = css({
  flexShrink: 0,
  paddingX: '0.375rem',
  paddingY: '0.125rem',
  fontSize: '0.75rem',
  color: 'greyscale.700',
})

const pickedRemoveCls = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  paddingX: '0.25rem',
  fontSize: '1rem',
  lineHeight: 1,
  color: 'greyscale.500',
  _hover: { color: 'danger.600' },
})

const selfBusyCls = css({
  margin: '0.375rem 0 0',
  fontSize: '0.75rem',
  color: 'danger.600',
})
