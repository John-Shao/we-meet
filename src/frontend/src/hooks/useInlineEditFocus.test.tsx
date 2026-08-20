import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { useInlineEditFocus } from './useInlineEditFocus'

/**
 * `useInlineEditFocus` 的契约。各个行内编辑现场都靠它,所以钉在 hook 这一层:
 * 站点侧的测试(如 settings 的 EditableRow.test.tsx)只需要验「ref 接对了」。
 */
const Harness = ({ withTrigger = true }: { withTrigger?: boolean }) => {
  const [editing, setEditing] = useState(false)
  const { fieldRef, triggerRef } = useInlineEditFocus(editing)

  if (!editing) {
    return (
      <button
        type="button"
        ref={withTrigger ? triggerRef : undefined}
        onClick={() => setEditing(true)}
      >
        编辑
      </button>
    )
  }
  return (
    <input
      ref={fieldRef}
      aria-label="名称"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

describe('useInlineEditFocus', () => {
  it('挂载时不抢焦点', () => {
    render(<Harness />)

    expect(document.body).toHaveFocus()
  })

  it('进入编辑态时焦点落到字段上', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(screen.getByRole('textbox', { name: '名称' })).toHaveFocus()
  })

  it('退出编辑态时焦点回到触发按钮', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    // 焦点归还被延迟到下一拍(避免 Enter 提交后误激活 ✎ 按钮),等待它落位。
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '编辑' })).toHaveFocus()
    )
  })

  it('没挂 triggerRef 时退出编辑不报错(只要「进编辑聚焦」的站点是合法用法)', () => {
    render(<Harness withTrigger={false} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('textbox')).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
    expect(document.body).toHaveFocus()
  })
})
