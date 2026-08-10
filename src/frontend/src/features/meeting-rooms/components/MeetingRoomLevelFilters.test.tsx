import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  MeetingRoomLevelType,
  MeetingRoomNode,
} from '../api/ApiMeetingRoom'
import { selectionByLevel } from '../utils/roomHierarchy'
import { MeetingRoomLevelFilters } from './MeetingRoomLevelFilters'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const makeNode = (
  id: string,
  name: string,
  levelType: MeetingRoomLevelType,
  parent: string | null,
  depth: number
): MeetingRoomNode => ({
  id,
  name,
  level_type: levelType,
  level_number: (depth + 1) as 1 | 2 | 3 | 4,
  parent,
  path: `${id}/`,
  depth,
  sort_order: 0,
  timezone: levelType === 'city' ? 'Asia/Shanghai' : null,
  effective_timezone: 'Asia/Shanghai',
  room_count: 0,
})

const nodes = [
  makeNode('cn', 'China', 'country_region', null, 0),
  makeNode('us', 'United States', 'country_region', null, 0),
  makeNode('sz', 'Shenzhen', 'city', 'cn', 1),
  makeNode('sf', 'San Francisco', 'city', 'us', 1),
  makeNode('campus', 'Industry Park', 'campus', 'sz', 2),
  makeNode('building', 'Building 1', 'building', 'campus', 3),
]

describe('MeetingRoomLevelFilters', () => {
  it('resolves a selected building into all four cascade values', () => {
    expect(selectionByLevel(nodes, 'building')).toEqual({
      country_region: 'cn',
      city: 'sz',
      campus: 'campus',
      building: 'building',
    })
  })

  it('enables each level from its parent and filters child options', () => {
    const onChange = vi.fn()
    render(
      <MeetingRoomLevelFilters
        nodes={nodes}
        selectedNodeId="cn"
        onChange={onChange}
      />
    )

    const city = screen.getByTestId('mr-filter-level-city')
    expect(city).not.toBeDisabled()
    expect(city).toHaveTextContent('Shenzhen')
    expect(city).not.toHaveTextContent('San Francisco')
    expect(screen.getByTestId('mr-filter-level-campus')).toBeDisabled()

    fireEvent.change(city, { target: { value: 'sz' } })
    expect(onChange).toHaveBeenCalledWith('sz')
  })

  it('falls back to the parent when a level is cleared', () => {
    const onChange = vi.fn()
    render(
      <MeetingRoomLevelFilters
        nodes={nodes}
        selectedNodeId="campus"
        onChange={onChange}
      />
    )

    fireEvent.change(screen.getByTestId('mr-filter-level-campus'), {
      target: { value: '' },
    })
    expect(onChange).toHaveBeenCalledWith('sz')
  })
})
