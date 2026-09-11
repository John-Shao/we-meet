import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDebouncedValue } from './useDebouncedValue'

const Probe = ({
  value,
  delayMs = 250,
  resetKey,
}: {
  value: string
  delayMs?: number
  resetKey?: unknown
}) => {
  const debounced = useDebouncedValue(value, delayMs, resetKey)
  return <span data-testid="out">{debounced}</span>
}

const out = () => screen.getByTestId('out')

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('用户停手之后才把新值放出去', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Probe value="张" />)
    expect(out()).toHaveTextContent('张')

    rerender(<Probe value="张三" />)
    // 还在打字:下游(网络请求)不该看到中间态。
    expect(out()).toHaveTextContent('张')
    act(() => {
      vi.advanceTimersByTime(249)
    })
    expect(out()).toHaveTextContent('张')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(out()).toHaveTextContent('张三')
  })

  it('连着敲:定时器重来,只认最后一个值', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Probe value="张" />)
    rerender(<Probe value="张三" />)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    rerender(<Probe value="张三丰" />)
    // 上一次的定时器该被清掉:再等 200ms(累计 400ms)也不该出现「张三」。
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(out()).toHaveTextContent('张')
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(out()).toHaveTextContent('张三丰')
  })

  it('resetKey 换了立刻采用当前值,不等满延迟', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Probe value="张" resetKey="dept-a" />)
    expect(out()).toHaveTextContent('张')

    // 切部门/切视图会把输入框清空:新列表不该先被上一个上下文的词筛一下。
    rerender(<Probe value="" resetKey="dept-b" />)
    expect(out()).toBeEmptyDOMElement()
    // 而且那个旧词不会过一会儿又被放回来。
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(out()).toBeEmptyDOMElement()
  })

  it('值没变就不重新计时(免得每次渲染都推后一次)', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Probe value="张" />)
    rerender(<Probe value="张三" />)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    // 同值重渲染:不该把 250ms 的窗口重新起算。
    rerender(<Probe value="张三" />)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(out()).toHaveTextContent('张三')
  })

  it('卸载后不再 setState(定时器被清掉)', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(<Probe value="张" />)
    rerender(<Probe value="张三" />)
    unmount()
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(1000)
      })
    ).not.toThrow()
  })
})
