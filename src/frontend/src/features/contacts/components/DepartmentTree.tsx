import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { RiArrowRightSLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'

import type { DirectoryDepartment } from '../api/ApiDirectory'

/** 展开态跨路由持久化:从 /contacts 切到消息页再回来,树还是你离开时的样子。 */
const STORAGE_KEY = 'we-meet:contacts-dept-expanded'

interface Props {
  departments: DirectoryDepartment[]
  selectedId: string | null
  onSelect: (id: string) => void
  /**
   * 就地筛选词(按部门名,大小写不敏感)。非空时忽略折叠状态:只留命中的节点与
   * 它们的祖先,祖先一律展开 —— 否则筛出来的深层部门会因为祖先收着而看不见。
   */
  filter?: string
}

/** 拍平后的一行。树是拍平渲染的:arity 靠 aria-level 表达(ARIA 允许扁平树)。 */
interface TreeRow {
  dept: DirectoryDepartment
  depth: number
  hasKids: boolean
  expanded: boolean
}

const readStoredExpanded = (): string[] => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : []
  } catch {
    // 隐私模式 / 脏数据:展开态这次会话里仍然可用,只是不跨路由。
    return []
  }
}

/**
 * 可折叠部门树(飞书式):从扁平部门列表(带 parent)在客户端建树。
 *
 * 相比「一排无标记按钮」多出来的几件事:
 *   - 每个节点右侧显示直属人数(member_count 后端 annotate,不额外请求);
 *   - 选中一个深层部门时自动展开它的祖先链,否则那一行根本不在屏幕上;
 *   - 展开态与筛选词各管一段:筛选时忽略折叠,收起时恢复。
 *
 * 键盘与语义:role="tree"/"treeitem" + aria-level/aria-expanded/aria-selected,
 * 上下键移动、右键展开或下钻、左键收起或回父级、Home/End 到首尾,roving tabindex
 * (整棵树只占一个 Tab 停靠点,不然 50 个部门要按 50 次 Tab)。展开箭头是 tabIndex=-1
 * 的独立按钮:鼠标点它只展开,键盘走左右键,两者不会互相抢。
 */
export const DepartmentTree = ({
  departments,
  selectedId,
  onSelect,
  filter = '',
}: Props) => {
  const { t } = useTranslation('contacts')

  const { childrenOf, byId } = useMemo(() => {
    // 按 parent 分组;'' = 根。父 id 不在集合内的也归到根,防孤儿。
    const ids = new Set(departments.map((d) => d.id))
    const byId = new Map(departments.map((d) => [d.id, d]))
    const childrenOf = new Map<string, DirectoryDepartment[]>()
    for (const d of departments) {
      const key = d.parent && ids.has(d.parent) ? d.parent : ''
      const arr = childrenOf.get(key) ?? []
      arr.push(d)
      childrenOf.set(key, arr)
    }
    return { childrenOf, byId }
  }, [departments])

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(readStoredExpanded())
  )
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())

  const updateExpanded = useCallback(
    (update: (prev: Set<string>) => Set<string>) => {
      setExpanded((prev) => {
        const next = update(prev)
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
        } catch {
          // 同上:存不下不影响本次会话的展开/收起。
        }
        return next
      })
    },
    []
  )

  const toggle = useCallback(
    (id: string) =>
      updateExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [updateExpanded]
  )

  const expandMany = useCallback(
    (ids: string[]) =>
      updateExpanded((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const id of ids) {
          if (!next.has(id)) {
            next.add(id)
            changed = true
          }
        }
        // 没变化就返回原引用,免得白白触发一次重渲染。
        return changed ? next : prev
      }),
    [updateExpanded]
  )

  // 选中部门 → 展开它的祖先链。要上溯(而不是只看 parent 一层),因为深链
  // /contacts?dept=<孙部门> 落地时中间两层也是收着的。
  useEffect(() => {
    if (!selectedId) return
    const chain: string[] = []
    let cursor = byId.get(selectedId)?.parent ?? null
    // 上限防脏数据成环。
    while (cursor && chain.length < 32) {
      chain.unshift(cursor)
      cursor = byId.get(cursor)?.parent ?? null
    }
    expandMany(chain)
  }, [selectedId, byId, expandMany])

  const query = filter.trim().toLowerCase()

  const rows = useMemo(() => {
    const out: TreeRow[] = []
    // 筛选:自己命中、或**有命中的后代**的节点才留(否则孙部门命中而中间层被滤掉,
    // 屏幕上就断了)。
    const kept = new Set<string>()
    if (query) {
      const mark = (d: DirectoryDepartment): boolean => {
        // 不用 reduce + `||` 短路:那样第一个命中的孩子之后就不再看别的孩子了。
        let hit = d.name.toLowerCase().includes(query)
        for (const kid of childrenOf.get(d.id) ?? []) {
          if (mark(kid)) hit = true
        }
        if (hit) kept.add(d.id)
        return hit
      }
      for (const root of childrenOf.get('') ?? []) mark(root)
    }

    const walk = (key: string, depth: number) => {
      for (const d of childrenOf.get(key) ?? []) {
        if (query && !kept.has(d.id)) continue
        const hasKids = (childrenOf.get(d.id) ?? []).length > 0
        const open = query ? true : expanded.has(d.id)
        out.push({ dept: d, depth, hasKids, expanded: open })
        if (hasKids && open) walk(d.id, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [childrenOf, expanded, query])

  const focusAt = (index: number) => {
    const row = rows[index]
    if (!row) return
    setFocusedId(row.dept.id)
    itemRefs.current.get(row.dept.id)?.focus()
  }

  const onRowKeyDown =
    (index: number, row: TreeRow) => (e: React.KeyboardEvent) => {
      // Enter/Space 不在这里处理:treeitem 本身就是 <button>,原生就会触发 click。
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          focusAt(index + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          focusAt(index - 1)
          break
        case 'Home':
          e.preventDefault()
          focusAt(0)
          break
        case 'End':
          e.preventDefault()
          focusAt(rows.length - 1)
          break
        case 'ArrowRight':
          e.preventDefault()
          if (row.hasKids && !row.expanded) toggle(row.dept.id)
          else focusAt(index + 1)
          break
        case 'ArrowLeft': {
          e.preventDefault()
          if (row.hasKids && row.expanded) {
            toggle(row.dept.id)
            break
          }
          // 回父级 = 往上找第一个层级更浅的可见行。
          for (let i = index - 1; i >= 0; i--) {
            if (rows[i].depth < row.depth) {
              focusAt(i)
              break
            }
          }
          break
        }
        default:
          break
      }
    }

  /** 命中片段高亮 —— 筛选时能一眼看出命中在名字的哪一段。 */
  const labelOf = (name: string): ReactNode => {
    if (!query) return name
    const at = name.toLowerCase().indexOf(query)
    if (at < 0) return name
    return (
      <>
        {name.slice(0, at)}
        <mark className={markCls}>{name.slice(at, at + query.length)}</mark>
        {name.slice(at + query.length)}
      </>
    )
  }

  if (rows.length === 0) {
    return query ? (
      <p className={emptyCls} data-testid="contacts-dept-no-match">
        {t('page.noDeptMatch')}
      </p>
    ) : null
  }

  return (
    <div role="tree" aria-label={t('page.departments')}>
      {rows.map((row, index) => {
        const { dept, depth, hasKids, expanded: open } = row
        const active = selectedId === dept.id
        const focused = focusedId ? focusedId === dept.id : index === 0
        return (
          <div
            key={dept.id}
            className={cx(
              rowCls,
              css({
                backgroundColor: active ? 'selected.bg' : 'transparent',
                _hover: {
                  backgroundColor: active ? 'selected.bg' : 'greyscale.100',
                },
                // 与左栏那四个入口同一个选中标记:左侧实色条。同一列里不该有
                // 两套「选中」长相(底色在深色下天然微弱,实色条不会)。
                '&::before': {
                  content: '""',
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: '2px',
                  backgroundColor: active ? 'selected.accent' : 'transparent',
                },
              })
            )}
            style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
          >
            {hasKids ? (
              <button
                type="button"
                // 键盘走左右键(见 onRowKeyDown),这里只服务鼠标 —— 不进 Tab 序列。
                tabIndex={-1}
                onClick={() => toggle(dept.id)}
                aria-label={open ? t('tree.collapse') : t('tree.expand')}
                data-testid={`contacts-dept-toggle-${dept.id}`}
                className={chevronCls}
              >
                <RiArrowRightSLine
                  size={16}
                  style={{
                    transition: 'transform var(--durations-fast)',
                    transform: open ? 'rotate(90deg)' : 'none',
                  }}
                />
              </button>
            ) : (
              <span className={chevronSpacerCls} />
            )}
            <button
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={active}
              aria-expanded={hasKids ? open : undefined}
              tabIndex={focused ? 0 : -1}
              onClick={() => {
                setFocusedId(dept.id)
                onSelect(dept.id)
              }}
              onKeyDown={onRowKeyDown(index, row)}
              ref={(el) => {
                if (el) itemRefs.current.set(dept.id, el)
                else itemRefs.current.delete(dept.id)
              }}
              data-testid={`contacts-dept-${dept.id}`}
              className={cx(
                nameCls,
                css({
                  color: active ? 'selected.text' : 'greyscale.800',
                  fontWeight: active ? '600' : undefined,
                })
              )}
            >
              <span className={nameTextCls}>{labelOf(dept.name)}</span>
              {dept.member_count > 0 && (
                <span className={countCls}>
                  {t('page.count', { count: dept.member_count })}
                </span>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}

const rowCls = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const chevronCls = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.25rem',
  height: '1.75rem',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
})
const chevronSpacerCls = css({ flexShrink: 0, width: '1.25rem' })
const nameCls = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  paddingY: '0.5rem',
  paddingRight: '0.75rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
})
const nameTextCls = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const countCls = css({
  flexShrink: 0,
  fontSize: '0.6875rem',
  fontVariantNumeric: 'tabular-nums',
  color: 'greyscale.500',
})
const markCls = css({
  backgroundColor: 'selected.bg',
  color: 'selected.text',
  borderRadius: '2px',
})
const emptyCls = css({
  margin: 0,
  paddingX: '1rem',
  paddingY: '0.5rem',
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})
