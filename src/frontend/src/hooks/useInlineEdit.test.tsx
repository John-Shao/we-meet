import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { InlineEditField } from '@/components/InlineEditField'
import { useInlineEdit, type UseInlineEditOptions } from './useInlineEdit'

/**
 * `useInlineEdit` 状态机的契约 —— 无按钮行内编辑唯一的语义来源。
 *
 * 交互约定(与文件头注释一致):单行 Enter 保存、Esc 取消、失焦自动保存;
 * 多行 Enter 换行。这里用 `InlineEditField` 作为展示层跑真渲染,重点钉住:
 * 提交/取消各只一次、未改动不提交、校验不过留在编辑态、保存失败可重试。
 */
const Harness = (props: Partial<UseInlineEditOptions> & { value: string }) => {
  const edit = useInlineEdit({
    value: props.value,
    onSave: props.onSave ?? (async () => {}),
    validate: props.validate,
    multiline: props.multiline,
    formatError: props.formatError,
    onSaveError: props.onSaveError,
  })

  if (!edit.editing) {
    return (
      <button ref={edit.triggerRef} onClick={edit.startEdit}>
        编辑
      </button>
    )
  }

  return (
    <div>
      <InlineEditField
        ref={edit.fieldRef}
        multiline={props.multiline}
        value={edit.draft}
        onChange={edit.setDraft}
        onKeyDown={edit.onFieldKeyDown}
        onBlur={edit.onFieldBlur}
        disabled={edit.busy}
        testid="field"
      />
      {edit.error && <span role="alert">{edit.error}</span>}
    </div>
  )
}

const start = () => {
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  return screen.getByTestId('field')
}

describe('useInlineEdit 状态机', () => {
  it('Enter 保存一次并退出编辑', async () => {
    const onSave = vi.fn(async () => {})
    render(<Harness value="a" onSave={onSave} />)

    const field = start()
    fireEvent.change(field, { target: { value: 'b' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('b')
    await waitFor(() =>
      expect(screen.queryByTestId('field')).not.toBeInTheDocument()
    )
  })

  it('Esc 取消:不保存、退出编辑、焦点回到触发按钮', () => {
    const onSave = vi.fn(async () => {})
    render(<Harness value="a" onSave={onSave} />)

    const field = start()
    fireEvent.change(field, { target: { value: 'b' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('field')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑' })).toHaveFocus()
  })

  it('失焦自动保存一次', async () => {
    const onSave = vi.fn(async () => {})
    render(<Harness value="a" onSave={onSave} />)

    const field = start()
    fireEvent.change(field, { target: { value: 'b' } })
    fireEvent.blur(field)

    expect(onSave).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByTestId('field')).not.toBeInTheDocument()
    )
  })

  it('未改动就失焦/回车:不保存,只退出', () => {
    const onSave = vi.fn(async () => {})
    render(<Harness value="a" onSave={onSave} />)

    const field = start()
    fireEvent.blur(field)

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('field')).not.toBeInTheDocument()
  })

  it('校验不过:失焦不保存、留在编辑态、显示错误', () => {
    const onSave = vi.fn(async () => {})
    render(
      <Harness
        value="a"
        onSave={onSave}
        validate={(v) => (v ? '' : '不能为空')}
      />
    )

    const field = start()
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('field')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('不能为空')
  })

  it('保存失败:formatError 上屏、留在编辑态;修好后仍可失焦保存', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    render(
      <Harness
        value="a"
        onSave={onSave}
        formatError={(e) => (e instanceof Error ? e.message : String(e))}
      />
    )

    const field = start()
    fireEvent.change(field, { target: { value: 'b' } })
    fireEvent.blur(field)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    )
    expect(screen.getByTestId('field')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(1)

    // 修复草稿后再次失焦:上一次失败的 ignoreNextBlur 不能吞掉这次提交。
    fireEvent.change(screen.getByTestId('field'), { target: { value: 'c' } })
    fireEvent.blur(screen.getByTestId('field'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByTestId('field')).not.toBeInTheDocument()
    )
  })

  it('多行字段:Enter 换行不保存,失焦才保存', async () => {
    const onSave = vi.fn(async () => {})
    render(<Harness value="a" onSave={onSave} multiline />)

    const field = start()
    fireEvent.change(field, { target: { value: 'b' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    // 多行 Enter 是换行,不是提交。
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('field')).toBeInTheDocument()

    fireEvent.blur(field)
    expect(onSave).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByTestId('field')).not.toBeInTheDocument()
    )
  })
})
