import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// 每例后卸载渲染树并清空 localStorage —— 日历设置写 localStorage,不隔离会串味。
afterEach(() => {
  cleanup()
  localStorage.clear()
})
