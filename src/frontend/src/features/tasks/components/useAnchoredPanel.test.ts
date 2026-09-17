import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

import { useAnchoredPanel } from './useAnchoredPanel'

/** 触发原生 toggle:面板开关由 <details>.open 决定,hook 从事件里读。 */
const toggle = (anchor: HTMLDetailsElement, open: boolean) =>
  act(() => {
    anchor.open = open
    anchor.dispatchEvent(new Event('toggle'))
  })

/** 把触发元素挂成 <details>,并按给定矩形喂给 hook。 */
const mountPanel = (rect: Partial<DOMRect>, open: boolean) => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect)
  const anchor = document.createElement('details')
  document.body.append(anchor)
  if (open) anchor.open = true
  const view = renderHook(() => {
    const ref = useRef<HTMLDetailsElement>(anchor)
    return useAnchoredPanel(ref)
  })
  return { anchor, view }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useAnchoredPanel', () => {
  it('anchors the panel under the trigger with a 4px gap', () => {
    const { anchor, view } = mountPanel(
      { top: 10, bottom: 42, right: 500, width: 120, height: 32 },
      true
    )
    toggle(anchor, true)
    expect(view.result.current).toEqual({
      top: 46,
      right: window.innerWidth - 500,
      maxHeight: window.innerHeight - 46 - 8,
    })
  })

  it('clamps a trigger outside the viewport so the panel stays visible', () => {
    const { anchor, view } = mountPanel(
      {
        top: 10,
        bottom: 42,
        right: window.innerWidth + 300,
        width: 120,
        height: 32,
      },
      true
    )
    toggle(anchor, true)
    expect(view.result.current?.right).toBe(8)
  })

  it('drops the position while the trigger is closed', () => {
    const { anchor, view } = mountPanel(
      { top: 10, bottom: 42, right: 500, width: 120, height: 32 },
      false
    )
    expect(view.result.current).toBeUndefined()
    toggle(anchor, true)
    expect(view.result.current?.top).toBe(46)
    toggle(anchor, false)
    expect(view.result.current).toBeUndefined()
  })

  it('leaves the panel alone when the trigger has no layout yet', () => {
    const { anchor, view } = mountPanel({}, true)
    toggle(anchor, true)
    expect(view.result.current).toBeUndefined()
  })
})
