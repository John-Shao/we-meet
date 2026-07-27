import { useEffect, useRef, useState } from 'react'
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
 * 都占掉小半个对话框,把视频会议/会议室等字段挤到折叠线以下。改成:
 * - 已选的人做成 chips **排在输入框内**,输入框本身就是选人区;
 * - 候选列表改成聚焦时才出现的**浮层**,不参与布局、不撑高对话框;
 * - 键盘可用:↑/↓ 移高亮、Enter 选中/取消、Backspace 删最后一个、Esc 收起
 *   (Esc 只收浮层,不关整个对话框)。
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

  // 结果变了就把高亮拉回第一条,免得停在越界的下标上。
  useEffect(() => setActive(0), [selectable])

  // 浮层活在对话框的滚动容器里(overflowY:auto),字段靠底时会被裁掉半截 ——
  // 展开时把浮层本身滚进可视区。
  useEffect(() => {
    if (open) listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  // 键盘移动高亮时把它滚进可视区(浮层自身是滚动容器)。
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (id: string, label: string) => {
    onToggle(id, label)
    // 选完清空输入继续搜下一个(对齐飞书),焦点留在输入框。
    setQuery('')
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
      setOpen(true)
      setActive((i) => Math.min(i + 1, selectable.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const m = selectable[active]
      if (open && m) {
        e.preventDefault()
        pick(m.id, labelOf(m))
      }
    } else if (e.key === 'Escape' && open) {
      // 只收浮层。Modal 的 Escape 挂在 document 上,不拦住会连对话框一起关掉
      // (React 事件挂在根容器,stopPropagation 能截住往 document 的冒泡)。
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'Backspace' && !query && selected.size > 0) {
      const [id, label] = [...selected.entries()][selected.size - 1]
      onToggle(id, label)
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
      {/* 输入框 = chips + 内嵌 input。input 自身 flex:1 铺满 chips 右侧,
          点「空白区」落到的就是它,不用再给容器挂取焦点的鼠标事件。 */}
      <div className={open ? boxFocusedCls : boxCls}>
        {[...selected.entries()].map(([id, label]) => (
          <span key={id} className={chipCls}>
            <MemberAvatar name={label} size="1.125rem" />
            <span className={chipLabelCls}>{label}</span>
            <button
              type="button"
              onClick={() => onToggle(id, label)}
              aria-label={t('form.removeAttendee', { name: label })}
              className={chipRemoveCls}
            >
              ×
            </button>
          </span>
        ))}
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
          placeholder={
            selected.size === 0 ? t('form.searchPlaceholder') : undefined
          }
          data-testid="event-attendee-search"
          className={innerInputCls}
        />
      </div>

      {open && (
        <div
          className={popoverCls}
          ref={listRef}
          data-testid="attendee-options"
        >
          {isFetching && selectable.length === 0 ? (
            <p className={hintCls}>{t('form.loading')}</p>
          ) : selectable.length === 0 ? (
            <p className={hintCls}>{t('form.noResults')}</p>
          ) : (
            selectable.map((m, i) => {
              const label = labelOf(m)
              const checked = selected.has(m.id)
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
                  aria-pressed={checked}
                  className={i === active ? optionActiveCls : optionCls}
                >
                  <MemberAvatar
                    name={label}
                    src={m.avatar_url}
                    size="1.75rem"
                  />
                  <span className={optionLabelCls}>{label}</span>
                  {checked && <span className={optionCheckCls}>✓</span>}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

const wrapCls = css({ position: 'relative' })

const boxBase = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.25rem',
  minHeight: '2.25rem',
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  cursor: 'text',
} as const

// 聚焦态整类切换,不 cx 叠加同属性(panda-cx-atomic-order-trap)。
const boxCls = css({
  ...boxBase,
  border: '1px solid token(colors.greyscale.300)',
})
const boxFocusedCls = css({
  ...boxBase,
  border: '1px solid token(colors.primary.500)',
})

const innerInputCls = css({
  flex: 1,
  minWidth: '6rem',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  paddingY: '0.25rem',
  fontSize: '0.875rem',
  color: 'greyscale.900',
})

const chipCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingLeft: '0.25rem',
  paddingRight: '0.125rem',
  paddingY: '0.125rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.100',
  fontSize: '0.8125rem',
  color: 'greyscale.800',
  maxWidth: '100%',
})

const chipLabelCls = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const chipRemoveCls = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  paddingX: '0.125rem',
  lineHeight: 1,
  color: 'greyscale.500',
  _hover: { color: 'danger.600' },
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

const optionCheckCls = css({
  flexShrink: 0,
  fontSize: '0.875rem',
  color: 'primary.600',
  _dark: { color: 'primaryDark.700' },
})

const hintCls = css({
  padding: '0.625rem 0.75rem',
  margin: 0,
  color: 'greyscale.500',
  fontSize: '0.875rem',
})
