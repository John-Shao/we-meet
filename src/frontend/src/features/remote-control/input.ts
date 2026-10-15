import { Kind } from '../../../../desktop/src/remote-control/wire'
import type { ControllerInput } from '../../../../desktop/src/remote-control/controller-transport'

/** Pointer coordinates stay in CSS client space; contain letterboxes are excluded. */
export function videoPoint(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  videoWidth: number,
  videoHeight: number,
  clientX: number,
  clientY: number
) {
  if (
    ![
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      videoWidth,
      videoHeight,
      clientX,
      clientY,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    videoWidth <= 0 ||
    videoHeight <= 0
  )
    return
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
  const width = videoWidth * scale,
    height = videoHeight * scale
  const left = rect.left + (rect.width - width) / 2,
    top = rect.top + (rect.height - height) / 2
  const x = (clientX - left) / width,
    y = (clientY - top) / height
  if (x < 0 || x > 1 || y < 0 || y > 1) return
  return { x, y }
}

const keys: Record<string, readonly [number, boolean?]> = {
  Escape: [0x01],
  Digit1: [0x02],
  Digit2: [0x03],
  Digit3: [0x04],
  Digit4: [0x05],
  Digit5: [0x06],
  Digit6: [0x07],
  Digit7: [0x08],
  Digit8: [0x09],
  Digit9: [0x0a],
  Digit0: [0x0b],
  Minus: [0x0c],
  Equal: [0x0d],
  Backspace: [0x0e],
  Tab: [0x0f],
  KeyQ: [0x10],
  KeyW: [0x11],
  KeyE: [0x12],
  KeyR: [0x13],
  KeyT: [0x14],
  KeyY: [0x15],
  KeyU: [0x16],
  KeyI: [0x17],
  KeyO: [0x18],
  KeyP: [0x19],
  BracketLeft: [0x1a],
  BracketRight: [0x1b],
  Enter: [0x1c],
  ControlLeft: [0x1d],
  KeyA: [0x1e],
  KeyS: [0x1f],
  KeyD: [0x20],
  KeyF: [0x21],
  KeyG: [0x22],
  KeyH: [0x23],
  KeyJ: [0x24],
  KeyK: [0x25],
  KeyL: [0x26],
  Semicolon: [0x27],
  Quote: [0x28],
  Backquote: [0x29],
  ShiftLeft: [0x2a],
  Backslash: [0x2b],
  KeyZ: [0x2c],
  KeyX: [0x2d],
  KeyC: [0x2e],
  KeyV: [0x2f],
  KeyB: [0x30],
  KeyN: [0x31],
  KeyM: [0x32],
  Comma: [0x33],
  Period: [0x34],
  Slash: [0x35],
  ShiftRight: [0x36],
  NumpadMultiply: [0x37],
  AltLeft: [0x38],
  Space: [0x39],
  CapsLock: [0x3a],
  F1: [0x3b],
  F2: [0x3c],
  F3: [0x3d],
  F4: [0x3e],
  F5: [0x3f],
  F6: [0x40],
  F7: [0x41],
  F8: [0x42],
  F9: [0x43],
  F10: [0x44],
  NumLock: [0x45],
  ScrollLock: [0x46],
  Numpad7: [0x47],
  Numpad8: [0x48],
  Numpad9: [0x49],
  NumpadSubtract: [0x4a],
  Numpad4: [0x4b],
  Numpad5: [0x4c],
  Numpad6: [0x4d],
  NumpadAdd: [0x4e],
  Numpad1: [0x4f],
  Numpad2: [0x50],
  Numpad3: [0x51],
  Numpad0: [0x52],
  NumpadDecimal: [0x53],
  F11: [0x57],
  F12: [0x58],
  NumpadEnter: [0x1c, true],
  ControlRight: [0x1d, true],
  NumpadDivide: [0x35, true],
  AltRight: [0x38, true],
  Home: [0x47, true],
  ArrowUp: [0x48, true],
  PageUp: [0x49, true],
  ArrowLeft: [0x4b, true],
  ArrowRight: [0x4d, true],
  End: [0x4f, true],
  ArrowDown: [0x50, true],
  PageDown: [0x51, true],
  Insert: [0x52, true],
  Delete: [0x53, true],
}
export function keyInput(
  code: string,
  down: boolean,
  repeat = false
): ControllerInput | undefined {
  const scan = keys[code]
  if (scan)
    return {
      kind: Kind.Key,
      code: scan[0],
      extended: !!scan[1],
      action: down ? 1 : 0,
      repeat,
    }
}
export function forbiddenChord(pressed: Set<string>) {
  const ctrl = pressed.has('ControlLeft') || pressed.has('ControlRight')
  const alt = pressed.has('AltLeft') || pressed.has('AltRight')
  const shift = pressed.has('ShiftLeft') || pressed.has('ShiftRight')
  return (
    (ctrl && alt && pressed.has('Delete')) ||
    (ctrl && alt && shift && pressed.has('F10'))
  )
}
export function shortcutKeys(codes: string[]): ControllerInput[] {
  const pressed = new Set<string>()
  for (const code of codes) {
    pressed.add(code)
    if (!keyInput(code, true) || forbiddenChord(pressed))
      throw new Error('invalid_shortcut')
  }
  return [
    ...codes.map((code) => keyInput(code, true)!),
    ...codes
      .slice()
      .reverse()
      .map((code) => keyInput(code, false)!),
  ]
}
