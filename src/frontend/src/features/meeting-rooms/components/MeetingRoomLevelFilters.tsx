import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'

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
          <select
            key={levelType}
            className={cx(selectChrome, selectCls)}
            value={selection[levelType] ?? ''}
            disabled={!enabled}
            aria-label={t(`filters.levelTypes.${levelType}`)}
            data-testid={`mr-filter-level-${levelType}`}
            onChange={(event) => {
              const nodeId = event.target.value
              if (nodeId) onChange(nodeId)
              else onChange(index === 0 ? null : (parentId ?? null))
            }}
          >
            <option value="">
              {t('filters.levelAllOf', {
                level: t(`filters.levelTypes.${levelType}`),
              })}
            </option>
            {options.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
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
const selectCls = css({
  minWidth: '7.25rem',
  maxWidth: '11rem',
  fontSize: '0.8125rem',
  paddingY: '0.375rem',
})
