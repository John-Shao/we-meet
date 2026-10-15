import { describe, expect, it } from 'vitest'
import { forbiddenChord, keyInput, shortcutKeys, videoPoint } from './input'

function permutations(keys: string[]): string[][] {
  if (keys.length < 2) return [keys]
  return keys.flatMap((key, index) =>
    permutations(keys.filter((_, at) => at !== index)).map((tail) => [
      key,
      ...tail,
    ])
  )
}

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
  it('rejects all 216 reserved-chord orders and modifier side combinations only when completed', () => {
    let sequences = 0
    for (const ctrl of ['ControlLeft', 'ControlRight']) {
      for (const alt of ['AltLeft', 'AltRight']) {
        const chords = [
          [ctrl, alt, 'Delete'],
          [ctrl, alt, 'ShiftLeft', 'F10'],
          [ctrl, alt, 'ShiftRight', 'F10'],
        ]
        for (const chord of chords) {
          for (const order of permutations(chord)) {
            for (let length = 1; length <= order.length; length++) {
              const prefix = order.slice(0, length)
              expect(forbiddenChord(new Set(prefix))).toBe(
                length === order.length
              )
              if (length < order.length)
                expect(() => shortcutKeys(prefix)).not.toThrow()
              else
                expect(() => shortcutKeys(prefix)).toThrow('invalid_shortcut')
            }
            sequences++
          }
        }
      }
    }
    expect(sequences).toBe(216)
  })
  it('keeps standalone F10, repeat, numpad decimal and ordinary shortcuts available', () => {
    expect(shortcutKeys(['F10']).map((key) => key.action)).toEqual([1, 0])
    expect(keyInput('F10', true, true)).toMatchObject({
      code: 0x44,
      extended: false,
      repeat: true,
    })
    expect(() =>
      shortcutKeys(['ControlLeft', 'AltRight', 'NumpadDecimal'])
    ).not.toThrow()
    expect(forbiddenChord(new Set(['ControlLeft', 'KeyC']))).toBe(false)
  })
})
