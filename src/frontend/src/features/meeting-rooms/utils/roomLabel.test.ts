import { describe, expect, it } from 'vitest'

import { roomBuildingIdentifier, roomIdentifier } from './roomLabel'

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
