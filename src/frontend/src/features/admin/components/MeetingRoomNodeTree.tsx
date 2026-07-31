import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiEditLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'

import type { AdminMeetingRoomNode } from '../api/adminMeetingRooms'

interface Props {
  nodes: AdminMeetingRoomNode[]
  /** null = the "all rooms" pseudo-root. */
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAddChild: (parent: AdminMeetingRoomNode) => void
  onEdit: (node: AdminMeetingRoomNode) => void
  onDelete: (node: AdminMeetingRoomNode) => void
}

/**
 * The building / floor hierarchy for the console (P9), with per-node actions.
 *
 * Same client-side tree build as the department console, including the rule
 * that a node whose parent was filtered out falls back to the root list rather
 * than disappearing along with its rooms.
 */
export const MeetingRoomNodeTree = ({
  nodes,
  selectedId,
  onSelect,
  onAddChild,
  onEdit,
  onDelete,
}: Props) => {
  const { t } = useTranslation('admin')

  const childrenOf = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id))
    const map = new Map<string, AdminMeetingRoomNode[]>()
    for (const node of nodes) {
      const key = node.parent && ids.has(node.parent) ? node.parent : ''
      const arr = map.get(key) ?? []
      arr.push(node)
      map.set(key, arr)
    }
    return map
  }, [nodes])

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderNodes = (parentKey: string, depth: number): ReactNode =>
    (childrenOf.get(parentKey) ?? []).map((node) => {
      const kids = childrenOf.get(node.id) ?? []
      const isExpanded = expanded.has(node.id)
      const active = selectedId === node.id
      return (
        <div key={node.id}>
          <div
            className={active ? rowActiveCls : rowIdleCls}
            style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
          >
            {kids.length > 0 ? (
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => toggle(node.id)}
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
              onClick={() => onSelect(node.id)}
              data-testid={`admin-mr-node-${node.id}`}
              className={active ? nodeLabelActiveCls : nodeLabelCls}
            >
              {node.name}
              {node.room_count > 0 && (
                <span className={countCls}> · {node.room_count}</span>
              )}
            </button>
            <span data-row-actions className={actionsCls}>
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => onAddChild(node)}
                aria-label={t('meetingRooms.newSubLevel')}
                tooltip={t('meetingRooms.newSubLevel')}
              >
                <RiAddLine size={16} />
              </Button>
              <Button
                variant="quaternaryText"
                size="icon24"
                onPress={() => onEdit(node)}
                aria-label={t('meetingRooms.editLevel')}
                tooltip={t('meetingRooms.editLevel')}
              >
                <RiEditLine size={16} />
              </Button>
              {/* 同部门树:一排行尾动作里只有删除不可逆,hover 才转红。 */}
              <Button
                variant="quaternaryDanger"
                size="icon24"
                onPress={() => onDelete(node)}
                aria-label={t('actions.delete')}
                tooltip={t('actions.delete')}
              >
                <RiDeleteBinLine size={16} />
              </Button>
            </span>
          </div>
          {kids.length > 0 && isExpanded && renderNodes(node.id, depth + 1)}
        </div>
      )
    })

  return (
    <div>
      <div className={selectedId === null ? rowActiveCls : rowIdleCls}>
        <span className={css({ flexShrink: 0, width: '1.25rem' })} />
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={selectedId === null ? nodeLabelActiveCls : nodeLabelCls}
        >
          {t('meetingRooms.allRooms')}
        </button>
      </div>
      {renderNodes('', 0)}
    </div>
  )
}

const rowBase = {
  display: 'flex',
  alignItems: 'center',
  borderBottom: '1px solid token(colors.greyscale.100)',
  // 每一行都留 3px 左边条,只有选中行才上色 —— 否则选中时内容会横跳 3px。
  // 边条是选中态的主要信号:底色差异在深色下天然微弱,一条实色竖线不会。
  borderLeftWidth: '3px',
  borderLeftStyle: 'solid',
} as const
// Two complete classes rather than cx-layering the background: atomic classes
// resolve by stylesheet order, not by the order they are combined.
const rowIdleCls = css({
  ...rowBase,
  borderLeftColor: 'transparent',
  backgroundColor: 'transparent',
  _hover: {
    backgroundColor: 'greyscale.100',
    '& [data-row-actions]': { opacity: 1 },
  },
})
const rowActiveCls = css({
  ...rowBase,
  // selected.* 语义 token 自带深浅两套(见 panda.config)—— 不要退回手写
  // primary.*,那个色阶不随主题翻转,漏一处 _dark 整行就糊了。
  borderLeftColor: 'selected.accent',
  backgroundColor: 'selected.bg',
  _hover: { '& [data-row-actions]': { opacity: 1 } },
})
const nodeLabelBase = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  paddingY: '0.5rem',
  paddingRight: '0.5rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const
const nodeLabelCls = css({ ...nodeLabelBase, color: 'greyscale.800' })
const nodeLabelActiveCls = css({
  ...nodeLabelBase,
  color: 'selected.text',
  fontWeight: '600',
})
const countCls = css({ color: 'greyscale.400', fontWeight: 'normal' })
const actionsCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  paddingRight: '0.375rem',
  opacity: 0,
  transition: 'opacity 0.12s',
})
