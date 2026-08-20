import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { EditableRow } from './SettingsDialog'

/**
 * 「系统设置 → 账号管理 → 用户名 / 邮箱」那一行的**焦点与提交行为**。
 *
 * 交互已统一成无按钮:点铅笔进入编辑只有输入框,`Enter` 保存、`Esc` 取消、
 * 失焦自动保存。这里钉的是 EditableRow 与 `useInlineEdit` 的**接线**是否对
 * (ref / 键盘 / 失焦 / onSave 都传到了 hook);状态机本身的边界在
 * `useInlineEdit.test.tsx` 里钉。
 *
 * t 被 mock 成原样返回 key:断言的是结构与行为,不是文案 —— 改措辞不该弄红测试。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// SettingsDialog 只为「打开日历/文档」拿一下 routes,而 `@/routes` 会把整棵路由树
// (features/rooms → LiveKit 的模糊背景 worker)拉进来,那边在**模块顶层**调
// URL.createObjectURL —— jsdom 里没有这个 API,于是本文件在 import 阶段就炸。
vi.mock('@/routes', () => ({ routes: {} }))

const setup = (onSave: (v: string) => Promise<void> = async () => {}) =>
  render(
    <EditableRow
      label="用户名"
      value="张三"
      placeholder="未设置"
      onSave={onSave}
    />
  )

const edit = () => {
  fireEvent.click(screen.getByRole('button'))
  return screen.getByRole('textbox')
}

describe('EditableRow 的无按钮编辑', () => {
  it('挂载时不抢焦点(对话框刚打开时焦点该由 Modal 决定)', () => {
    setup()

    expect(document.body).toHaveFocus()
  })

  it('点「编辑」后只有输入框(没有保存/取消按钮),且已带当前值', () => {
    setup()
    const input = edit()

    expect(input).toHaveFocus()
    expect(input).toHaveValue('张三')
    // 无按钮:编辑态里读态的「编辑」按钮已卸载,也没有保存/取消。
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('Enter 保存一次并退出编辑', async () => {
    const onSave = vi.fn(async () => {})
    setup(onSave)
    const input = edit()

    fireEvent.change(input, { target: { value: '李四' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('李四')
    await waitFor(() =>
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    )
  })

  it('失焦自动保存一次', async () => {
    const onSave = vi.fn(async () => {})
    setup(onSave)
    const input = edit()

    fireEvent.change(input, { target: { value: '李四' } })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    )
  })

  it('未改动就失焦:不保存,只退出编辑', async () => {
    const onSave = vi.fn(async () => {})
    setup(onSave)
    const input = edit()

    fireEvent.blur(input)

    expect(onSave).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    )
  })

  it('未改动就回车:不保存,只退出编辑', () => {
    const onSave = vi.fn(async () => {})
    setup(onSave)
    const input = edit()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('Esc 退出编辑、焦点回到「编辑」按钮、不触发保存', () => {
    const onSave = vi.fn(async () => {})
    setup(onSave)
    const input = edit()

    fireEvent.change(input, { target: { value: '李四' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveFocus()
  })
})
