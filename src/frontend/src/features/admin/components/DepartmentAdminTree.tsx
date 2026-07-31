import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiArrowRightSLine,
  RiAddLine,
  RiEditLine,
  RiDeleteBinLine,
  RiFolderTransferLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'

import type { AdminDepartment } from '../api/adminDepartments'

interface Props {
  departments: AdminDepartment[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAddChild: (parent: AdminDepartment) => void
  onRename: (dept: AdminDepartment) => void
  onMove: (dept: AdminDepartment) => void
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
  onMove,
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
              // 每行都留 3px 左边条,只有选中行上色,避免选中时内容横跳。
              borderLeftWidth: '3px',
              borderLeftStyle: 'solid',
              // selected.* 自带深浅两套(见 panda.config),不用再手写 _dark。
              borderLeftColor: active ? 'selected.accent' : 'transparent',
              backgroundColor: active ? 'selected.bg' : 'transparent',
              _hover: {
                backgroundColor: active ? 'selected.bg' : 'greyscale.100',
                '& [data-row-actions]': { opacity: 1 },
              },
            })}
            style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
          >
            {hasKids ? (
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => toggle(d.id)}
                aria-label={isExpanded ? 'collapse' : 'expand'}
                aria-expanded={isExpanded}
              >
                <RiArrowRightSLine
                  size={16}
                  style={{
                    transition: 'transform 0.12s',
                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                  }}
                />
              </Button>
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
                color: active ? 'selected.text' : 'greyscale.800',
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
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => onAddChild(d)}
                aria-label={t('org.newSubDepartment')}
                tooltip={t('org.newSubDepartment')}
              >
                <RiAddLine size={16} />
              </Button>
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => onRename(d)}
                aria-label={t('org.rename')}
                tooltip={t('org.rename')}
              >
                <RiEditLine size={16} />
              </Button>
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => onMove(d)}
                aria-label={t('org.move')}
                tooltip={t('org.move')}
              >
                <RiFolderTransferLine size={16} />
              </Button>
              {/* 删除是这排里唯一不可逆的动作:静止时同为中性灰,hover 才转红。 */}
              <Button
                variant="quaternaryDanger"
                size="icon24"
                onPress={() => onDelete(d)}
                aria-label={t('actions.delete')}
                tooltip={t('actions.delete')}
              >
                <RiDeleteBinLine size={16} />
              </Button>
            </span>
          </div>
          {hasKids && isExpanded && renderNodes(d.id, depth + 1)}
        </div>
      )
    })
  }

  return <div>{renderNodes('', 0)}</div>
}

