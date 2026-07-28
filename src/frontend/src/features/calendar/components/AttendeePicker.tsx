import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { useDirectoryMemberSearch, MemberAvatar } from '@/features/contacts'

interface Props {
  /** 已选参与者 id → 显示名(组织者不在其中)。 */
  selected: Map<string, string>
  onToggle: (id: string, label: string) => void
}

/**
 * 参与者选取(对标飞书「添加联系人、群或邮箱」)。
 *
 * 取代原先「搜索框 + 常驻整份成员列表」的写法 —— 那份列表不论有没有在选人
 * 都占掉小半个对话框,把视频会议/会议室等字段挤到折叠线以下。现在的结构:
 * - 搜索框始终是干净的一行,已选的人**不**塞进框里当 chips;
 * - 候选列表是聚焦时才出现的**浮层**,不参与布局、不撑高对话框;
 * - 命中一次加一个人(单选,非勾选列表):选完清空输入并收起浮层,已加的人
 *   从候选里去掉 —— 同一个人不会被重复呈现;
 * - 已选的人列在搜索框下面,一人一行,行尾 × 移除;
 * - 键盘可用:↑/↓ 移高亮、Enter 添加、Esc 收浮层(只收浮层,不关对话框)。
 *
 * 飞书的「批量添加」大弹窗(组织架构树/外部联系人/邮箱三分类)不在此实现:
 * 我们目前只有单一组织通讯录一个来源,分类面板无内容可分。
 */
export const AttendeePicker = ({ selected, onToggle }: Props) => {
  const { t } = useTranslation('calendar')
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 只有键盘移高亮才需要把它滚进可视区。鼠标滚动列表时指针下方的行会连着
  // 触发 mouseenter → setActive,若那时也跟着 scrollIntoView,列表就会被拽
  // 回高亮行 —— 表现为「滚不动、一松手就弹回」。
  const keyNavRef = useRef(false)

  // 单选语义:已加进来的人不再出现在候选里(他就在下面的参与者列表中)。
  const options = useMemo(
    () => selectable.filter((m) => !selected.has(m.id)),
    [selectable, selected]
  )

  // 结果变了就把高亮拉回第一条,免得停在越界的下标上。
  // 依赖只能取 query:hook 里的 selectable 是每次渲染新建的数组(filter 的
  // 返回值),拿它做依赖等于每渲染一次就把 active 打回 0 —— 悬停/滚动刚
  // 改的高亮下一帧就被抹掉,配合下面的 scrollIntoView 就是那个「弹簧」。
  useEffect(() => setActive(0), [query])

  // 浮层活在对话框的滚动容器里(overflowY:auto),字段靠底时会被裁掉半截 ——
  // 展开时把浮层本身滚进可视区。
  useEffect(() => {
    if (open) listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  // 键盘移动高亮时把它滚进可视区(浮层自身是滚动容器)。
  useEffect(() => {
    if (!open || !keyNavRef.current) return
    keyNavRef.current = false
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

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
      if (open && m) {
        e.preventDefault()
        pick(m.id, labelOf(m))
      }
    } else if (e.key === 'Escape' && open) {
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
          而是列在下面的参与者列表 —— 选到十几个人时框子不会涨成一大块。 */}
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
        className={open ? inputFocusedCls : inputIdleCls}
      />

      {open && (
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

      {/* 已选参与者:一人一行(对齐飞书的「参与者 (N)」列表)。人数在外层的
          「已选 N 人」上已经有了,这里不再重复标题。 */}
      {selected.size > 0 && (
        <ul className={pickedListCls} data-testid="attendee-picked">
          {[...selected.entries()].map(([id, label]) => (
            <li key={id} className={pickedRowCls}>
              <MemberAvatar name={label} size="1.5rem" />
              <span className={pickedNameCls}>{label}</span>
              <button
                type="button"
                onClick={() => onToggle(id, label)}
                aria-label={t('form.removeAttendee', { name: label })}
                className={pickedRemoveCls}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const wrapCls = css({ position: 'relative' })

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

const pickedRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.50',
})

const pickedNameCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.875rem',
  color: 'greyscale.800',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
