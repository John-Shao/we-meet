import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('enables each level from its parent and filters child options', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <MeetingRoomLevelFilters
        nodes={nodes}
        selectedNodeId="cn"
        onChange={onChange}
      />
    )

    const city = screen.getByTestId('mr-filter-level-city')
    const cityButton = within(city).getByRole('button')
    expect(cityButton).not.toBeDisabled()
    expect(
      within(screen.getByTestId('mr-filter-level-campus')).getByRole('button')
    ).toBeDisabled()

    await user.click(cityButton)
    expect(screen.getByRole('option', { name: 'Shenzhen' })).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'San Francisco' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Shenzhen' }))
    expect(onChange).toHaveBeenCalledWith('sz')
  })

  it('falls back to the parent when a level is cleared', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <MeetingRoomLevelFilters
        nodes={nodes}
        selectedNodeId="campus"
        onChange={onChange}
      />
    )

    await user.click(
      within(screen.getByTestId('mr-filter-level-campus')).getByRole('button')
    )
    await user.click(
      screen.getByRole('option', { name: /filters\.levelAllOf/ })
    )
    expect(onChange).toHaveBeenCalledWith('sz')
  })
})
