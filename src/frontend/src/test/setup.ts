import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jest-dom 的匹配器(toBeInTheDocument / toHaveTextContent …)。依赖一直在
// package.json 里但没接线 —— 此前全是纯逻辑测试,没有组件测试用得上它。
import '@testing-library/jest-dom/vitest'

// 每例后卸载渲染树并清空 localStorage —— 日历设置写 localStorage,不隔离会串味。
afterEach(() => {
  cleanup()
  localStorage.clear()
})
