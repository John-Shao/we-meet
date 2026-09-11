import { useEffect, useRef, useState } from 'react'

/**
 * 防抖后的值:输入框立刻响应,昂贵的下游(网络请求)等用户停手。
 *
 * 通讯录的「筛选成员」用它:筛选改成服务端做的事之后,每敲一个字都发一次请求既
 * 浪费又会打乱分页状态 —— 而用一个 `setTimeout` 手写一遍,最容易被忘掉的是
 * 「组件卸载时清掉定时器」和「值相同就别再 setState」这两件小事。
 *
 * `resetKey` 换掉时**立刻**采用当前值、不再等。这个「立刻」必须是**渲染期**的,不能
 * 放在 effect 里,原因是调用方把它当查询 key 的一部分(通讯录的 `q` 就是):
 *
 * - effect 里改:那一次渲染已经把新上下文 + **旧值**算进了 key,TanStack 的观察者
 *   在这个 commit 上看到新 key 就会发一次请求 —— 也就是「切部门时先按上一个部门的
 *   筛选词查一次」,慢网络下先亮一句「没有匹配的成员」;
 * - 渲染期改(下面的 `setDebounced`):React 会**丢弃**本次渲染的输出并立刻重跑,
 *   于是这一帧算出的 key 已经是新值,旧 key 从不提交,那次请求也就不存在。
 *   渲染期 setState 只允许用在**同一个组件**的状态上,这里正是。
 *
 * 调用方仍然要在**事件处理器**里把输入框清空(见 ContactsRoute 的 clearFilter):
 * 渲染期采用的是「这一帧拿到的 value」,而 value 是父组件的状态 —— 父组件如果等
 * 自己的 effect 才清,这一帧拿到的还是旧词,那这次 reset 就只是把 250ms 缩短成 0,
 * 请求照发。
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

  if (previousResetKey.current !== resetKey) {
    previousResetKey.current = resetKey
    // 本帧的输出会被 React 丢掉,所以下面那行 `previousDebounced.current = debounced`
    // 来不及覆盖这里写进去的值;重跑时 resetKey 已经相等,分支不再进入。
    previousDebounced.current = value
    setDebounced(value)
  }

  useEffect(() => {
    if (value === previousDebounced.current) return
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs, resetKey])

  return debounced
}
