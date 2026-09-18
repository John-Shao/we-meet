import { useCallback, useState } from 'react'

/**
 * 二级导航栏的收起态 + 跨路由持久化（与「通讯录」同一套 storage 约定）。
 *
 * 每个模块一个 key，存 `'1'` / `'0'`；隐私模式下这次会话里仍然能收起/展开，只是
 * 不记住。单独一个文件（而不是和 `SubNav` 的组件放一起）：那边同时导出组件，混在
 * 一个文件里会让 Fast Refresh 失效（eslint react-refresh/only-export-components）。
 */
export const useCollapsibleSubNav = (storageKey: string) => {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  })

  const toggle = useCallback(() => {
    setCollapsed((previous) => {
      try {
        localStorage.setItem(storageKey, previous ? '0' : '1')
      } catch {
        /* 隐私模式:不记住而已。 */
      }
      return !previous
    })
  }, [storageKey])

  return { collapsed, toggle }
}
