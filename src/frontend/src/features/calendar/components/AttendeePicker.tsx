import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { MemberAvatar } from '@/features/contacts'

import { fetchFreeBusy } from '../api/fetchCalendar'
import { BulkAttendeeDialog } from './BulkAttendeeDialog'

interface Props {
  /** 已选参与者 id → 显示名(组织者不在其中)。 */
  selected: Map<string, string>
  onToggle: (id: string, label: string) => void
  /** 预填参与者的头像(编辑态从事件带进来);选人面板选中的会自动补进缓存。 */
  initialAvatars?: Map<string, string>
  /** 所选时段 —— 用来给每位参与者标忙/闲;全天或时间未填时传 null。 */
  slotStart?: Date | null
  slotEnd?: Date | null
  /** 编辑态:忙闲里剔除当前日程自身,原参与者不被自己这场误报忙碌。 */
  excludeEventId?: string
  /** 发起人自己 —— 只用于「你在该时段有其他日程」的提示,不进参与者列表。 */
  selfId?: string
}

/**
 * 参与者选取。
 *
 * 只有一条路径:「添加参与者」开 [BulkAttendeeDialog](复用 IM「新建群聊」
 * 的左搜索勾选 + 右已选面板),一次勾一串人再确定。原先并存的「行内搜索框 +
 * 候选浮层」已去掉 —— 两个入口做同一件事,行内那个还只能一次加一个人。
 *
 * 已选的人列在按钮下面,一人一行:头像 + 名字 + 忙/闲 + 行尾 × 移除。
 * 忙/闲取代了原先单独一块的忙闲时间条。
 */
export const AttendeePicker = ({
  selected,
  onToggle,
  initialAvatars,
  slotStart,
  slotEnd,
  excludeEventId,
  selfId,
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
  const dayStart = slotStart ? new Date(slotStart) : null
  dayStart?.setHours(0, 0, 0, 0)
  const dayEnd = dayStart ? new Date(dayStart) : null
  dayEnd?.setDate(dayEnd.getDate() + 1)
  const busyIds = useMemo(
    () => [...selected.keys(), ...(selfId ? [selfId] : [])],
    [selected, selfId]
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

  return (
    <div>
      <button
        type="button"
        onClick={() => setBulkOpen(true)}
        data-testid="event-attendee-add"
        className={addBtnCls}
      >
        + {t('form.bulkAdd')}
      </button>

      {/* 已选参与者:一人一行(对齐飞书的「参与者 (N)」列表),行内直接标
          忙/闲。人数在外层的「已选 N 人」上已经有了,这里不重复标题。 */}
      {selected.size > 0 && (
        <ul className={pickedListCls} data-testid="attendee-picked">
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

      {/* 发起人自己不在参与者列表里,但「我这个点也有事」同样该提醒。 */}
      {showStatus && selfId && isBusy(selfId) && (
        <p className={selfBusyCls} data-testid="attendee-self-busy">
          {t('freebusy.selfBusy')}
        </p>
      )}

      {bulkOpen && (
        <BulkAttendeeDialog
          initial={selected}
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

const addBtnCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.75rem',
  paddingY: '0.375rem',
  border: '1px dashed token(colors.greyscale.300)',
  borderRadius: 8,
  backgroundColor: 'greyscale.000',
  color: 'primary.500',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.50', borderColor: 'primary.500' },
  _dark: { color: 'primaryDark.700' },
})

// 已选列表:人多了自己滚,不把对话框顶长。
const pickedListCls = css({
  listStyle: 'none',
  margin: '0.5rem 0 0',
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
