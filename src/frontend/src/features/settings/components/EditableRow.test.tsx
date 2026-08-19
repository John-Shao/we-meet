import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { EditableRow } from './SettingsDialog'

/**
 * 「系统设置 → 账号管理 → 用户名 / 邮箱」那一行的**焦点行为**。
 *
 * 为什么值得一条测试:焦点这种事没有第二处兜底 —— 类型检查、lint、构建全都看不见
 * 它,页面上也不报错,只是点了「编辑」还得再点一下输入框才能打字。它极容易在后续
 * 重构(包一层容器、换成受控组件、改 effect 依赖)里静默失效。
 *
 * t 被 mock 成原样返回 key:断言的是焦点与结构,不是文案 —— 改措辞不该弄红测试。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// SettingsDialog 只为「打开日历/文档」拿一下 routes,而 `@/routes` 会把整棵路由树
// (features/rooms → LiveKit 的模糊背景 worker)拉进来,那边在**模块顶层**调
// URL.createObjectURL —— jsdom 里没有这个 API,于是本文件在 import 阶段就炸。
// 与这一行的焦点行为毫无关系,直接掐掉;顺带省掉转译整棵树的几秒钟。
vi.mock('@/routes', () => ({ routes: {} }))

const setup = () =>
  render(
    <EditableRow
      label="用户名"
      value="张三"
      placeholder="未设置"
      onSave={async () => {}}
    />
  )

describe('EditableRow 的焦点流转', () => {
  it('挂载时不抢焦点(对话框刚打开时焦点该由 Modal 决定)', () => {
    setup()

    expect(document.body).toHaveFocus()
  })

  it('点「编辑」后焦点直接落在输入框上,且已带着当前值', () => {
    setup()

    fireEvent.click(screen.getByRole('button'))

    const input = screen.getByRole('textbox')
    expect(input).toHaveFocus()
    expect(input).toHaveValue('张三')
  })

  it('Esc 退出编辑后焦点回到「编辑」按钮,而不是掉到 body', () => {
    setup()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    // 只剩「编辑」这一个按钮(编辑态里的取消/保存已随输入框一起卸载)。
    expect(screen.getByRole('button')).toHaveFocus()
  })
})
