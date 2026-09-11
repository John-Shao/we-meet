import { useEffect, useRef, useState } from 'react'

/**
 * 防抖后的值:输入框立刻响应,昂贵的下游(网络请求)等用户停手。
 *
 * 通讯录的「筛选成员」用它:筛选改成服务端做的事之后,每敲一个字都发一次请求既
 * 浪费又会打乱分页状态 —— 而用一个 `setTimeout` 手写一遍,最容易被忘掉的是
 * 「组件卸载时清掉定时器」和「值相同就别再 setState」这两件小事。
 *
 * `resetKey` 换掉时**立刻**采用当前值、不再等:切部门/切视图会把输入框清空,而
 * 防抖里还压着上一个上下文的词 —— 不立刻清掉的话,新部门会先被旧词过滤一下
 * (屏幕上闪一眼不该有的空列表),250ms 后才回到正常。
 */
export const useDebouncedValue = <T>(
  value: T,
  delayMs = 250,
  resetKey?: unknown
): T => {
  const [debounced, setDebounced] = useState(value)
  const previousResetKey = useRef(resetKey)
  const previousDebounced = useRef(value)
  previousDebounced.current = debounced

  useEffect(() => {
    const contextChanged = previousResetKey.current !== resetKey
    previousResetKey.current = resetKey
    if (contextChanged) {
      setDebounced(value)
      return
    }
    if (value === previousDebounced.current) return
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs, resetKey])

  return debounced
}
