import { act, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
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

/** 每次 commit 记下观察到的值 —— 调用方的查询 key 正是这么算出来的。 */
const observed: string[] = []
const Observer = ({ value, resetKey }: { value: string; resetKey: unknown }) => {
  const debounced = useDebouncedValue(value, 250, resetKey)
  useEffect(() => {
    observed.push(debounced)
  })
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

  it('resetKey 换了之后,同一次 commit 上的观察者读到的也是新值', () => {
    // 上面那条用例只证明「最终」是新值 —— 而调用方(TanStack 的观察者在自己的 effect
    // 里读这个值算查询 key)看到的是**某一次 commit** 上的值。差别就在这一个 commit:
    // 把 reset 放在 effect 里,那次 commit 的观察者读到的还是旧词,于是老老实实按旧词
    // 发了请求(切部门时多一次往返,慢网络下先亮一句「没有匹配的成员」);放在渲染期,
    // 这一次 commit 就已经是新值。
    vi.useFakeTimers()
    observed.length = 0
    const { rerender } = render(<Observer value="张" resetKey="dept-a" />)
    expect(observed).toEqual(['张'])

    rerender(<Observer value="" resetKey="dept-b" />)
    expect(observed).toEqual(['张', ''])
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
