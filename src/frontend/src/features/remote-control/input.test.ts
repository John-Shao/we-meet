import { describe, expect, it } from 'vitest'
import { forbiddenChord, keyInput, shortcutKeys, videoPoint } from './input'

describe('remote input coordinates and keys', () => {
  it('uses CSS coordinates with contain letterboxes, negative positions and no DPR multiplication', () => {
    const rect = { left: -800, top: 20, width: 800, height: 600 }
    expect(videoPoint(rect, 3840, 2160, -400, 320)).toEqual({ x: 0.5, y: 0.5 })
    expect(videoPoint(rect, 3840, 2160, -400, 94)).toBeUndefined()
    expect(videoPoint(rect, 3840, 2160, -800, 95)).toEqual({ x: 0, y: 0 })
    expect(videoPoint(rect, 3840, 2160, 0, 545)).toEqual({ x: 1, y: 1 })
    expect(videoPoint(rect, 3840, 2160, 1, 320)).toBeUndefined()
    expect(videoPoint(rect, 0, 2160, -400, 320)).toBeUndefined()
    expect(videoPoint(rect, 3840, 2160, NaN, 320)).toBeUndefined()
    expect(
      videoPoint(
        { left: 0, top: 0, width: 800, height: 400 },
        400,
        800,
        299,
        100
      )
    ).toBeUndefined()
  })
  it('keeps modifier sides, extended navigation and key release order', () => {
    expect(keyInput('ControlRight', true)).toMatchObject({
      code: 0x1d,
      extended: true,
      action: 1,
    })
    expect(keyInput('ControlLeft', false)).toMatchObject({
      code: 0x1d,
      extended: false,
      action: 0,
    })
    expect(keyInput('KeyA', true, true)).toMatchObject({
      code: 0x1e,
      repeat: true,
    })
    expect(keyInput('MetaLeft', true)).toBeUndefined()
    expect(
      shortcutKeys(['ControlLeft', 'KeyV']).map((e) => [e.code, e.action])
    ).toEqual([
      [0x1d, 1],
      [0x2f, 1],
      [0x2f, 0],
      [0x1d, 0],
    ])
  })
  it('rejects system and emergency chords in any key order', () => {
    for (const chord of [
      ['Delete', 'AltRight', 'ControlLeft'],
      ['F10', 'ShiftRight', 'AltLeft', 'ControlRight'],
    ]) {
      expect(forbiddenChord(new Set(chord))).toBe(true)
      expect(() => shortcutKeys(chord)).toThrow('invalid_shortcut')
    }
    expect(forbiddenChord(new Set(['ControlLeft', 'KeyC']))).toBe(false)
  })
})
