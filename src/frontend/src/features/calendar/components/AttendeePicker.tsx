import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { useDirectoryMemberSearch, MemberAvatar } from '@/features/contacts'

import { fetchFreeBusy } from '../api/fetchCalendar'
import { BulkAttendeeDialog } from './BulkAttendeeDialog'

interface Props {
  /** 已选参与者 id → 显示名(组织者不在其中)。 */
  selected: Map<string, string>
  onToggle: (id: string, label: string) => void
  /** 预填参与者的头像(编辑态从事件带进来);搜索到过的人会自动补进缓存。 */
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
 * 参与者选取(对标飞书「添加联系人、群或邮箱」)。
 *
 * 取代原先「搜索框 + 常驻整份成员列表」的写法 —— 那份列表不论有没有在选人
 * 都占掉小半个对话框,把视频会议/会议室等字段挤到折叠线以下。现在的结构:
 * - 搜索框始终是干净的一行,已选的人**不**塞进框里当 chips;
 * - **输入了才有候选**:空关键词不列通讯录,浮层不出现;
 * - 命中一次加一个人(单选,非勾选列表):选完清空输入并收起浮层,已加的人
 *   从候选里去掉 —— 同一个人不会被重复呈现;
 * - 已选的人列在搜索框下面,一人一行,行内直接标忙/闲(取代原来单独一块的
 *   忙闲时间条),行尾 × 移除;
 * - 键盘可用:↑/↓ 移高亮、Enter 添加、Esc 收浮层(只收浮层,不关对话框)。
 *
 * 右上「批量添加」开 [BulkAttendeeDialog] —— 复用 IM「新建群聊」那块左搜索
 * 勾选 + 右已选面板,一次勾一串人。飞书那版还分组织架构树/外部联系人/邮箱
 * 三类,我们目前只有单一组织通讯录一个来源,分类面板无内容可分,故不分。
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
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()
  const [open, setOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 只有键盘移高亮才需要把它滚进可视区。鼠标滚动列表时指针下方的行会连着
  // 触发 mouseenter → setActive,若那时也跟着 scrollIntoView,列表就会被拽
  // 回高亮行 —— 表现为「滚不动、一松手就弹回」。
  const keyNavRef = useRef(false)

  // 头像缓存:selected 只有 id→名字,渲染已选行时拿不到头像 URL(会退成字母
  // 色块)。搜索结果里见过谁就把谁的头像记下来,编辑态的预填由 props 带入。
  // 纯缓存写入,不触发渲染,故直接在渲染期写 ref。
  const avatarsRef = useRef(new Map<string, string>())
  if (initialAvatars) {
    initialAvatars.forEach((url, id) => {
      if (url && !avatarsRef.current.has(id)) avatarsRef.current.set(id, url)
    })
  }
  selectable.forEach((m) => {
    if (m.avatar_url) avatarsRef.current.set(m.id, m.avatar_url)
  })

  // 空关键词不列通讯录(对齐飞书):搜索结果为空 = 不出浮层。
  const hasQuery = query.trim().length > 0
  // 单选语义:已加进来的人不再出现在候选里(他就在下面的参与者列表中)。
  const options = useMemo(
    () => (hasQuery ? selectable.filter((m) => !selected.has(m.id)) : []),
    [hasQuery, selectable, selected]
  )
  const showPopover = open && hasQuery

  // 忙闲:按「所选开始时刻当天」拉一次,判断每人在所选时段是否有冲突。
  // 只要状态(忙/闲),不再画时间条 —— 条那一块已按需求去掉。
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

  // 结果变了就把高亮拉回第一条,免得停在越界的下标上。
  // 依赖只能取 query:hook 里的 selectable 是每次渲染新建的数组(filter 的
  // 返回值),拿它做依赖等于每渲染一次就把 active 打回 0 —— 悬停/滚动刚
  // 改的高亮下一帧就被抹掉,配合下面的 scrollIntoView 就是那个「弹簧」。
  useEffect(() => setActive(0), [query])

  // 浮层活在对话框的滚动容器里(overflowY:auto),字段靠底时会被裁掉半截 ——
  // 展开时把浮层本身滚进可视区。
  useEffect(() => {
    if (showPopover) listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [showPopover])

  // 键盘移动高亮时把它滚进可视区(浮层自身是滚动容器)。
  useEffect(() => {
    if (!showPopover || !keyNavRef.current) return
    keyNavRef.current = false
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, showPopover])

  /** 单选:命中一次加一个人,清空输入并收起浮层,焦点留在输入框。 */
  const pick = (id: string, label: string) => {
    if (selected.has(id)) return
    onToggle(id, label)
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  const labelOf = (m: {
    id: string
    full_name?: string | null
    short_name?: string | null
    email?: string | null
  }) => m.full_name || m.short_name || m.email || m.id

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      keyNavRef.current = true
      setOpen(true)
      setActive((i) => Math.min(i + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      keyNavRef.current = true
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const m = options[active]
      if (showPopover && m) {
        e.preventDefault()
        pick(m.id, labelOf(m))
      }
    } else if (e.key === 'Escape' && showPopover) {
      // 只收浮层。Modal 的 Escape 挂在 document 上,不拦住会连对话框一起关掉
      // (React 事件挂在根容器,stopPropagation 能截住往 document 的冒泡)。
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div
      className={wrapCls}
      // 焦点整体离开(点到浮层里的行不算)才收起浮层。
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
    >
      {/* 搜索框始终是干净的一行(对齐飞书):已选的人不塞进框里当 chips,
          而是列在下面的参与者列表 —— 选到十几个人时框子不会涨成一大块。
          右侧「批量添加」开大面板,一次勾一串(复用 IM 新建群聊那块)。 */}
      <div className={searchRowCls}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('form.searchPlaceholder')}
          data-testid="event-attendee-search"
          className={showPopover ? inputFocusedCls : inputIdleCls}
        />
        <button
          type="button"
          onClick={() => setBulkOpen(true)}
          data-testid="event-attendee-bulk"
          className={bulkLinkCls}
        >
          + {t('form.bulkAdd')}
        </button>

        {showPopover && (
          <div
            className={popoverCls}
            ref={listRef}
            data-testid="attendee-options"
          >
            {isFetching && options.length === 0 ? (
              <p className={hintCls}>{t('form.loading')}</p>
            ) : options.length === 0 ? (
              <p className={hintCls}>{t('form.noResults')}</p>
            ) : (
              options.map((m, i) => {
                const label = labelOf(m)
                return (
                  <button
                    key={m.id}
                    type="button"
                    // 用 mousedown 提交,并阻止它把焦点从输入框上抢走 —— 否则
                    // 点一下就 blur → 浮层先关闭,click 永远等不到。
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(m.id, label)
                    }}
                    onMouseEnter={() => setActive(i)}
                    data-testid={`event-attendee-${m.id}`}
                    className={i === active ? optionActiveCls : optionCls}
                  >
                    <MemberAvatar
                      name={label}
                      src={m.avatar_url}
                      size="1.75rem"
                    />
                    <span className={optionLabelCls}>{label}</span>
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

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
          onConfirm={(next) => {
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

const wrapCls = css({ position: 'relative' })

// 搜索行自己 relative:浮层锚在它上面。挂到外层 wrapCls 的话,top:100% 会
// 算到「输入框 + 已选列表」的底部,浮层就掉到列表下面去了。
const searchRowCls = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})

const bulkLinkCls = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  fontSize: '0.8125rem',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  _hover: { textDecoration: 'underline' },
  _dark: { color: 'primaryDark.700' },
})

const inputBase = {
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  fontSize: '0.875rem',
  color: 'greyscale.900',
  outline: 'none',
} as const

// 聚焦态整类切换,不 cx 叠加同属性(panda-cx-atomic-order-trap)。
const inputIdleCls = css({
  ...inputBase,
  border: '1px solid token(colors.greyscale.300)',
})
const inputFocusedCls = css({
  ...inputBase,
  border: '1px solid token(colors.primary.500)',
})

// 浮层:绝对定位盖在下方字段之上,不参与布局 —— 这是本次改造的要点,
// 候选列表再长也不会把对话框撑高。
const popoverCls = css({
  position: 'absolute',
  top: 'calc(100% + 0.25rem)',
  left: 0,
  right: 0,
  zIndex: 20,
  maxHeight: '13rem',
  overflowY: 'auto',
  paddingY: '0.25rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  boxShadow: '0 6px 16px rgba(0, 0, 0, 0.12)',
})

const optionBase = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  width: '100%',
  paddingX: '0.625rem',
  paddingY: '0.375rem',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
} as const

const optionCls = css({ ...optionBase, backgroundColor: 'transparent' })
const optionActiveCls = css({ ...optionBase, backgroundColor: 'greyscale.100' })

const optionLabelCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.875rem',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const hintCls = css({
  padding: '0.625rem 0.75rem',
  margin: 0,
  color: 'greyscale.500',
  fontSize: '0.875rem',
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
