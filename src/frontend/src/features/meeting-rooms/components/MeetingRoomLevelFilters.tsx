import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import {
  MEETING_ROOM_LEVEL_TYPES,
  type MeetingRoomNode,
} from '../api/ApiMeetingRoom'
import { selectionByLevel } from '../utils/roomHierarchy'

export const MeetingRoomLevelFilters = ({
  nodes,
  selectedNodeId,
  onChange,
}: {
  nodes: MeetingRoomNode[]
  selectedNodeId?: string | null
  onChange: (nodeId: string | null) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const selection = useMemo(
    () => selectionByLevel(nodes, selectedNodeId),
    [nodes, selectedNodeId]
  )

  return (
    <div className={cascadeCls}>
      {MEETING_ROOM_LEVEL_TYPES.map((levelType, index) => {
        const previousType = MEETING_ROOM_LEVEL_TYPES[index - 1]
        const parentId = previousType ? selection[previousType] : null
        const enabled = index === 0 || !!parentId
        const options = nodes.filter(
          (node) =>
            node.level_type === levelType &&
            (index === 0 ? node.parent === null : node.parent === parentId)
        )

        return (
          <Select
            key={levelType}
            className={selectCls}
            selectedKey={selection[levelType] ?? ''}
            isDisabled={!enabled}
            aria-label={t(`filters.levelTypes.${levelType}`)}
            data-testid={`mr-filter-level-${levelType}`}
            onSelectionChange={(key) => {
              const nodeId = String(key)
              if (nodeId) onChange(nodeId)
              else onChange(index === 0 ? null : (parentId ?? null))
            }}
            items={[
              {
                value: '',
                label: t('filters.levelAllOf', {
                  level: t(`filters.levelTypes.${levelType}`),
                }),
              },
              ...options.map((node) => ({
                value: node.id,
                label: node.name,
              })),
            ]}
          />
        )
      })}
    </div>
  )
}

const cascadeCls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
})
/**
 * 层级级联下拉。`border` 不能省:panda preflight 把 `*` 的 border-width 清成 0,
 * selectChrome 又只管外观不管边框 —— 原先是没有框的白方块,而统一焦点描边
 * (见 styles/index.css)需要有一条边框可染,否则聚焦时只剩一圈悬空光环。
 */
const selectCls = css({
  minWidth: '7.25rem',
  maxWidth: '11rem',
})
