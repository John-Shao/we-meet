import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jest-dom 的匹配器(toBeInTheDocument / toHaveTextContent …)。依赖一直在
// package.json 里但没接线 —— 此前全是纯逻辑测试,没有组件测试用得上它。
import '@testing-library/jest-dom/vitest'

// jsdom 里没有 URL.createObjectURL。这不是某一个测试的毛病:`stores/userChoices`
// → LiveKit 的模糊背景处理器(components/blur/TimerWorker.ts)在**模块顶层**就调
// 它,于是任何 import 落到那条链上的组件测试(系统设置对话框就是一例)都会在
// import 阶段直接抛 TypeError,和被测行为毫无关系。给一个够用的假实现,免得每个
// 测试各自去 mock 一整棵无关依赖树。
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
}

// 每例后卸载渲染树并清空 localStorage —— 日历设置写 localStorage,不隔离会串味。
afterEach(() => {
  cleanup()
  localStorage.clear()
})
