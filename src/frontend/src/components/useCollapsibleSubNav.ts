import { useCallback, useSyncExternalStore } from 'react'

/**
 * 二级导航栏的收起态 + 跨路由持久化（与「通讯录」同一套 storage 约定）。
 *
 * **同一 key 的所有使用点共享同一份状态**：收起入口在模块二级导航栏的栏头里，
 * 展开入口在**内容标题栏**里 —— 两处是不同组件（有些还跨文件：会议的内容页与
 * `MeetingNavPanel`、消息的 `ChatPane` 与 `ImRoute`），各自 `useState` 不会互相同步。
 * 所以这里用模块级订阅表 + `useSyncExternalStore`：任何组件用同一个 key 都能读到
 * 同一份状态、互相触发重渲染。
 *
 * 状态以 localStorage 为准（`'1'` / `'0'`），隐私模式（读写抛错）下退化成一次会话
 * 内的内存状态：仍然能收起/展开，只是不记住。
 *
 * 单独一个文件（而不是和 `SubNav` 的组件放一起）：那边同时导出组件，混在一个文件里
 * 会让 Fast Refresh 失效（eslint react-refresh/only-export-components）。
 */
const listeners = new Map<string, Set<() => void>>()
const memory = new Map<string, boolean>()

const read = (storageKey: string) => {
  try {
    const stored = localStorage.getItem(storageKey)
    return stored === null ? false : stored === '1'
  } catch {
    /* 隐私模式:读不到就当内存态。 */
    return memory.get(storageKey) ?? false
  }
}

const subscribe = (storageKey: string, listener: () => void) => {
  const set = listeners.get(storageKey) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(storageKey, set)

  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(storageKey)
  }
}

const write = (storageKey: string, collapsed: boolean) => {
  memory.set(storageKey, collapsed)
  try {
    localStorage.setItem(storageKey, collapsed ? '1' : '0')
  } catch {
    /* 隐私模式:不记住而已。 */
  }
  listeners.get(storageKey)?.forEach((listener) => listener())
}

export const useCollapsibleSubNav = (storageKey: string) => {
  const collapsed = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribe(storageKey, listener),
      [storageKey]
    ),
    useCallback(() => read(storageKey), [storageKey]),
    () => false
  )

  const toggle = useCallback(() => {
    write(storageKey, !read(storageKey))
  }, [storageKey])

  return { collapsed, toggle }
}
