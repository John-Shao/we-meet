import { useCallback, useEffect, useState, type RefObject } from 'react'

export interface AnchoredPanelPosition {
  top: number
  right: number
  maxHeight: number
}

/**
 * 给「横向可滑工具栏」里的 `<details>` 下拉面板算 `position: fixed` 坐标。
 *
 * 为什么必须 fixed:工具栏是 scroll container(`overflow-x: auto` ⇒ `overflow-y` 也按
 * `auto` 算),行内 `position: absolute` 的面板会被整块裁掉 —— 2026-09-17 实测:面板
 * 高 162px、可视高度 **0**。fixed 之后就不再受那个裁剪区域约束;面板仍是 `<details>`
 * 的 DOM 子节点,「点外面关闭 / Escape 关闭」那些逻辑照旧。
 *
 * 打开状态从**原生 `toggle` 事件**读(不是 React 的 onToggle):面板开关始终由
 * `<details>.open` 说了算,程序化关闭(选中一项、点外面)也会走到这里。
 *
 * 坐标按触发元素算,并在滚动/缩放时跟随(捕获阶段监听 scroll,工具栏自己横向滚动也
 * 能收到);触发元素滑出视口时面板钳在视口内,不会被推出屏幕。
 *
 * jsdom / 未布局的环境量不到矩形,这时不返回坐标,面板退回静态位置,测试不受影响。
 */
export const useAnchoredPanel = (
  anchorRef: RefObject<HTMLDetailsElement | null>,
  { gap = 4, minHeight = 160, margin = 8 } = {}
): AnchoredPanelPosition | undefined => {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<AnchoredPanelPosition>()

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const sync = () => setOpen(anchor.open)
    sync()
    anchor.addEventListener('toggle', sync)
    return () => anchor.removeEventListener('toggle', sync)
  }, [anchorRef])

  const measure = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const top = rect.bottom + gap
    setPosition({
      top,
      right: Math.max(margin, window.innerWidth - rect.right),
      maxHeight: Math.max(minHeight, window.innerHeight - top - margin),
    })
  }, [anchorRef, gap, margin, minHeight])

  useEffect(() => {
    if (!open) {
      setPosition(undefined)
      return
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [measure, open])

  return position
}
