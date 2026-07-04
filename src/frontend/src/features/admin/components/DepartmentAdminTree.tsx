import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiArrowRightSLine,
  RiAddLine,
  RiEditLine,
  RiDeleteBinLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'

import type { AdminDepartment } from '../api/adminDepartments'

interface Props {
  departments: AdminDepartment[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAddChild: (parent: AdminDepartment) => void
  onRename: (dept: AdminDepartment) => void
  onDelete: (dept: AdminDepartment) => void
}

/**
 * Editable department tree for the console: same client-side tree build as the
 * C 端 browse tree, plus per-node admin actions (add sub-department / rename /
 * delete). Orphan nodes (parent filtered out) fall back to root so nothing
 * disappears.
 */
export const DepartmentAdminTree = ({
  departments,
  selectedId,
  onSelect,
  onAddChild,
  onRename,
  onDelete,
}: Props) => {
  const { t } = useTranslation('admin')

  const childrenOf = useMemo(() => {
    const ids = new Set(departments.map((d) => d.id))
    const map = new Map<string, AdminDepartment[]>()
    for (const d of departments) {
      const key = d.parent && ids.has(d.parent) ? d.parent : ''
      const arr = map.get(key) ?? []
      arr.push(d)
      map.set(key, arr)
    }
    return map
  }, [departments])

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
              _hover: {
                backgroundColor: active ? 'primary.100' : 'greyscale.100',
                '& [data-row-actions]': { opacity: 1 },
              },
            })}
            style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
          >
            {hasKids ? (
              <button
                type="button"
                onClick={() => toggle(d.id)}
                aria-label={isExpanded ? 'collapse' : 'expand'}
                aria-expanded={isExpanded}
                className={iconBtn}
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
            <span
              data-row-actions
              className={css({
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '0.125rem',
                paddingRight: '0.375rem',
                opacity: 0,
                transition: 'opacity 0.12s',
              })}
            >
              <button
                type="button"
                onClick={() => onAddChild(d)}
                aria-label={t('org.newSubDepartment')}
                title={t('org.newSubDepartment')}
                className={iconBtn}
              >
                <RiAddLine size={15} />
              </button>
              <button
                type="button"
                onClick={() => onRename(d)}
                aria-label={t('org.rename')}
                title={t('org.rename')}
                className={iconBtn}
              >
                <RiEditLine size={15} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(d)}
                aria-label={t('actions.delete')}
                title={t('actions.delete')}
                className={iconBtn}
              >
                <RiDeleteBinLine size={15} />
              </button>
            </span>
          </div>
          {hasKids && isExpanded && renderNodes(d.id, depth + 1)}
        </div>
      )
    })
  }

  return <div>{renderNodes('', 0)}</div>
}

const iconBtn = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.5rem',
  height: '1.75rem',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  borderRadius: '4px',
  _hover: { backgroundColor: 'greyscale.200', color: 'greyscale.800' },
})
