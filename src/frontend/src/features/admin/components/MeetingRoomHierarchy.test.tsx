import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AdminMeetingRoomNode } from '../api/adminMeetingRooms'
import { MeetingRoomDialog } from './MeetingRoomDialog'
import { MeetingRoomNodeTree } from './MeetingRoomNodeTree'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const names = ['China', 'Shenzhen', 'Campus', 'Building 1']
const types = ['country_region', 'city', 'campus', 'building'] as const
const nodes: AdminMeetingRoomNode[] = names.map((name, depth) => ({
  id: `node${depth}`,
  name,
  parent: depth === 0 ? null : `node${depth - 1}`,
  path:
    Array.from({ length: depth + 1 }, (_, index) => `node${index}`).join('/') +
    '/',
  depth,
  level_number: (depth + 1) as 1 | 2 | 3 | 4,
  level_type: types[depth],
  sort_order: 0,
  timezone: depth === 1 ? 'Asia/Shanghai' : null,
  effective_timezone: 'Asia/Shanghai',
  is_active: true,
  room_count: 0,
  created_at: '2026-08-09T00:00:00Z',
}))

describe('fixed meeting-room hierarchy controls', () => {
  it('does not offer an add-child action on a building', () => {
    render(
      <MeetingRoomNodeTree
        nodes={nodes}
        query="Building 1"
        selectedId={null}
        onSelect={vi.fn()}
        onAddChild={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.getAllByLabelText('meetingRooms.newSubLevel')).toHaveLength(3)
  })

  it('locks a new room to the selected building', () => {
    render(
      <MeetingRoomDialog
        isOpen
        room={null}
        defaultNodeId="node3"
        nodes={nodes}
        facilities={[]}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const location = document.getElementById('mr-room-node')
    expect(location?.tagName).toBe('DIV')
    for (const name of names) expect(location).toHaveTextContent(name)
    expect(screen.getByLabelText('meetingRooms.floor')).toBeRequired()
  })
})
