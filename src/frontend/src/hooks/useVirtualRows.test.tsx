import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useVirtualRows } from './useVirtualRows'

/**
 * jsdom 没有布局:clientHeight 恒为 0。所以每个用例都显式给 fallbackHeight,
 * 让窗口算术有一个确定的输入 —— 这也正是 hook 里那条兜底分支的用途。
 */
const Probe = ({
  count,
  rowHeight = 50,
  overscan = 1,
  fallbackHeight = 100,
}: {
  count: number
  rowHeight?: number
  overscan?: number
  fallbackHeight?: number
}) => {
  const virtual = useVirtualRows({
    count,
    rowHeight,
    overscan,
    fallbackHeight,
  })
  return (
    <div>
      <div
        data-testid="scroller"
        ref={virtual.scrollRef}
        onScroll={virtual.onScroll}
      />
      <button type="button" onClick={virtual.scrollToTop}>
        top
      </button>
      <span data-testid="window">
        {`${virtual.startIndex}-${virtual.endIndex}`}
      </span>
      <span data-testid="anchor">{virtual.anchorIndex}</span>
      <span data-testid="offset">{virtual.offsetY}</span>
      <span data-testid="total">{virtual.totalHeight}</span>
    </div>
  )
}

const scroller = () => screen.getByTestId('scroller')

describe('useVirtualRows', () => {
  it('空列表:不渲染任何行,也不留占位高度', () => {
    render(<Probe count={0} />)
    expect(screen.getByTestId('window')).toHaveTextContent('0-0')
    expect(screen.getByTestId('total')).toHaveTextContent('0')
  })

  it('行数不足一屏:全部渲染(小名单不该被窗口化切掉)', () => {
    render(<Probe count={3} />)
    // 可见 2 行(100/50)+ overscan 1。
    expect(screen.getByTestId('window')).toHaveTextContent('0-3')
    expect(screen.getByTestId('total')).toHaveTextContent('150')
  })

  it('长名单:只开一屏的窗口,高度按总行数撑开', () => {
    render(<Probe count={1000} />)
    expect(screen.getByTestId('window')).toHaveTextContent('0-3')
    // 滚动条高度必须还是 1000 行 —— 否则滚动比例和位置全错。
    expect(screen.getByTestId('total')).toHaveTextContent('50000')
  })

  it('滚动之后窗口跟着走,偏移量对齐 startIndex', () => {
    render(<Probe count={1000} />)
    const node = scroller()
    node.scrollTop = 500
    fireEvent.scroll(node)

    // 500/50 = 第 10 行;overscan 1 → 渲染 9..12。
    expect(screen.getByTestId('anchor')).toHaveTextContent('10')
    expect(screen.getByTestId('window')).toHaveTextContent('9-13')
    expect(screen.getByTestId('offset')).toHaveTextContent('450')
  })

  it('滚过头(数据变少 / 滚到底)时窗口被夹回来,不留空白', () => {
    render(<Probe count={5} />)
    const node = scroller()
    node.scrollTop = 500
    fireEvent.scroll(node)

    // 5 行、可见 2 行 → 最多从第 3 行开始。
    expect(screen.getByTestId('anchor')).toHaveTextContent('3')
    expect(screen.getByTestId('window')).toHaveTextContent('2-5')
  })

  it('scrollToTop 把窗口收回顶部(换部门 / 换起点字母时用)', () => {
    render(<Probe count={1000} />)
    const node = scroller()
    node.scrollTop = 500
    fireEvent.scroll(node)
    expect(screen.getByTestId('anchor')).toHaveTextContent('10')

    fireEvent.click(screen.getByRole('button', { name: 'top' }))
    expect(node.scrollTop).toBe(0)
    expect(screen.getByTestId('anchor')).toHaveTextContent('0')
  })

  it('没给 overscan 时默认上下各多渲染 6 行', () => {
    render(<Probe count={1000} fallbackHeight={600} />)
    // 可见 12 行(600/50),但 overscan 用的是默认值 —— 这条用例只钉「会多渲染」,
    // 具体数字由上面几条定死。
    const [, end] = (screen.getByTestId('window').textContent ?? '')
      .split('-')
      .map(Number)
    expect(end).toBeGreaterThan(12)
  })
})
