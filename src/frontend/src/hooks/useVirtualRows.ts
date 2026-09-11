import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

export interface VirtualRowsOptions {
  /** 列表总行数(已加载的部分 —— 服务端还有多少页不影响窗口计算)。 */
  count: number
  /** 行高(px)。行高固定才谈得上窗口化,所以列表里的行必须等高。 */
  rowHeight: number
  /** 视口上下各多渲染几行,滚动时不至于看到空白。 */
  overscan?: number
  /** 量不到容器高度时(首帧、以及 jsdom 这种没有布局的环境)按它算可见行数。 */
  fallbackHeight?: number
}

export interface VirtualRows {
  /** 挂到滚动容器(overflow:auto 的那个元素)上 —— 它既要被量高度,也是滚动源。 */
  scrollRef: (node: HTMLDivElement | null) => void
  /** 量到的那个元素本身(调用方要用它当 IntersectionObserver 的 root 等)。 */
  scrollElement: HTMLDivElement | null
  onScroll: () => void
  /** 回到顶部。换部门 / 换起点字母时用:列表内容换了,滚动位置不该留在半山腰。 */
  scrollToTop: () => void
  /** 渲染窗口(含 overscan):渲染 [startIndex, endIndex)。 */
  startIndex: number
  endIndex: number
  /** 视口顶部那一行(不含 overscan)—— 悬浮字母头按它取。 */
  anchorIndex: number
  /** 窗口在整表里的像素偏移,给 translateY 用。 */
  offsetY: number
  /** 整表高度(撑出滚动条,让滚动位置和总行数对得上)。 */
  totalHeight: number
}

/**
 * 定高行列表的窗口化:只把可见的那二十来行放进 DOM。
 *
 * 为什么要有它:组织的「全部成员」动辄上千人,一次全渲染等于上千棵子树(每行还有
 * 头像、按钮、两个 span),滚动时浏览器每帧都要对付它们。窗口化之后 DOM 里始终只有
 * 一屏,行数再多也不影响滚动。
 *
 * 与 `content-visibility: auto` 的分工:那个只省排版、节点还在;这个连节点都不建。
 * 代价是屏幕外的行不在 DOM 里 —— 浏览器「页内查找」和 Tab 顺序都只看得到当前窗口。
 * 所以这里的窗口**总是**覆盖整屏再各多几行,而不是更激进的「只留视口内」。
 *
 * 行高必须固定:窗口化靠算术定位,量出来的高度一旦和实际不符,滚动就会有累积漂移。
 */
export const useVirtualRows = ({
  count,
  rowHeight,
  overscan = 6,
  fallbackHeight = 600,
}: VirtualRowsOptions): VirtualRows => {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(fallbackHeight)

  const scrollRef = useCallback((element: HTMLDivElement | null) => {
    setNode(element)
  }, [])

  const onScroll = useCallback(() => {
    const next = node?.scrollTop ?? 0
    setScrollTop((prev) => (next === prev ? prev : next))
  }, [node])

  const scrollToTop = useCallback(() => {
    if (node) node.scrollTop = 0
    setScrollTop(0)
  }, [node])

  useLayoutEffect(() => {
    if (!node) return
    const measure = () => setHeight(node.clientHeight || fallbackHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    // 拖窄/拖宽侧栏、开合右栏都会改高度,跟着量一次再算窗口。
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, fallbackHeight])

  // 数据变少(换部门、就地筛选)时浏览器会把 scrollTop 夹回去,但滚动事件不一定来 ——
  // 主动同步一次,免得窗口落在数据之外、屏幕一片空白。
  useEffect(() => {
    if (node && node.scrollTop !== scrollTop) setScrollTop(node.scrollTop)
  }, [node, count, scrollTop])

  const visibleCount = Math.max(1, Math.ceil(height / rowHeight))
  const maxStart = Math.max(0, count - visibleCount)
  const anchorIndex = Math.min(
    maxStart,
    Math.max(0, Math.floor(scrollTop / rowHeight))
  )

  return {
    scrollRef,
    scrollElement: node,
    onScroll,
    scrollToTop,
    startIndex: Math.max(0, anchorIndex - overscan),
    endIndex: Math.min(count, anchorIndex + visibleCount + overscan),
    anchorIndex,
    offsetY: Math.max(0, anchorIndex - overscan) * rowHeight,
    totalHeight: count * rowHeight,
  }
}
