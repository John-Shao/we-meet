import { describe, expect, it } from 'vitest'

import {
  roomBuildingIdentifier,
  roomIdentifier,
  roomResourceLabel,
  roomScheduleLabel,
} from './roomLabel'

describe('roomIdentifier', () => {
  it('uses the required room number as the primary label', () => {
    expect(roomIdentifier({ code: '1203', name: '' })).toBe('1203')
    expect(roomIdentifier({ code: '1203', name: 'Tide' })).toBe('1203 (Tide)')
  })

  it('keeps a defensive name fallback for legacy responses', () => {
    expect(roomIdentifier({ code: '', name: 'Tide' })).toBe('Tide')
  })
})

describe('roomBuildingIdentifier', () => {
  it('prefixes the room identifier with its building', () => {
    expect(
      roomBuildingIdentifier('Tower A', { code: '1203', name: 'Tide' })
    ).toBe('Tower A-1203 (Tide)')
  })

  it('does not add a separator when a legacy response lacks a building', () => {
    expect(roomBuildingIdentifier('', { code: '1203', name: '' })).toBe('1203')
  })
})

describe('roomScheduleLabel', () => {
  it('formats a named room with its building and capacity', () => {
    expect(
      roomScheduleLabel('腾讯大厦', { code: '1208', name: 'Tide' }, '12 人')
    ).toBe('腾讯大厦-1208 (Tide) · 12 人')
  })

  it('omits the room-name parentheses when the name is empty', () => {
    expect(
      roomScheduleLabel('联想大厦', { code: '208', name: '' }, '6 人')
    ).toBe('联想大厦-208 · 6 人')
  })
})

describe('roomResourceLabel', () => {
  it('matches the timeline capacity and facility summary', () => {
    expect(
      roomResourceLabel(
        {
          facilities: [
            { name: 'TV' },
            { name: 'Whiteboard' },
            { name: 'Projector' },
          ],
        },
        '100 people'
      )
    ).toBe('100 people · TV · Whiteboard')
  })

  it('omits empty capacity and facility values cleanly', () => {
    expect(
      roomResourceLabel(
        { facilities: [{ name: '' }, { name: 'Whiteboard' }] },
        ''
      )
    ).toBe('Whiteboard')
  })
})
