import { useMemo, useState, type ReactNode } from 'react'
import { RiArrowRightSLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

import type { DirectoryDepartment } from '../api/ApiDirectory'

interface Props {
  departments: DirectoryDepartment[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/**
 * 可折叠部门树(飞书式):从扁平部门列表(带 parent)在客户端建树,支持展开/收起。
 * 点名字选中该部门(右侧列其直属成员),点箭头仅展开/收起。父级缺失(被停用/过滤)
 * 的节点视为根,避免孤儿节点消失。
 */
export const DepartmentTree = ({ departments, selectedId, onSelect }: Props) => {
  // 按 parent 分组;'' = 根。父 id 不在集合内的也归到根,防孤儿。
  const childrenOf = useMemo(() => {
    const ids = new Set(departments.map((d) => d.id))
    const map = new Map<string, DirectoryDepartment[]>()
    for (const d of departments) {
      const key = d.parent && ids.has(d.parent) ? d.parent : ''
      const arr = map.get(key) ?? []
      arr.push(d)
      map.set(key, arr)
    }
    return map
  }, [departments])

  // 默认展开根层级,子层级收起(飞书式:一进来看到一级部门)。
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderNodes = (parentKey: string, depth: number): ReactNode => {
    const nodes = childrenOf.get(parentKey) ?? []
    return nodes.map((d) => {
      const kids = childrenOf.get(d.id) ?? []
      const hasKids = kids.length > 0
      const isExpanded = expanded.has(d.id)
      const active = selectedId === d.id
      return (
        <div key={d.id}>
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              borderBottom: '1px solid token(colors.greyscale.100)',
              backgroundColor: active ? 'primary.100' : 'transparent',
              _hover: { backgroundColor: active ? 'primary.100' : 'greyscale.100' },
            })}
            style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
          >
            {hasKids ? (
              <button
                type="button"
                onClick={() => toggle(d.id)}
                aria-label={isExpanded ? 'collapse' : 'expand'}
                aria-expanded={isExpanded}
                data-testid={`contacts-dept-toggle-${d.id}`}
                className={css({
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
                })}
              >
                <RiArrowRightSLine
                  size={16}
                  style={{
                    transition: 'transform 0.12s',
                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                  }}
                />
              </button>
            ) : (
              <span className={css({ flexShrink: 0, width: '1.25rem' })} />
            )}
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              data-testid={`contacts-dept-${d.id}`}
              className={css({
                flex: 1,
                minWidth: 0,
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
                paddingY: '0.5rem',
                paddingRight: '0.5rem',
                fontSize: '0.875rem',
                cursor: 'pointer',
                color: active ? 'primary.700' : 'greyscale.800',
                fontWeight: active ? '600' : undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              {d.name}
            </button>
          </div>
          {hasKids && isExpanded && renderNodes(d.id, depth + 1)}
        </div>
      )
    })
  }

  return <div>{renderNodes('', 0)}</div>
}
