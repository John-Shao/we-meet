import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal'

/**
 * Modal 的**焦点契约**。这一层的三条行为(开时把焦点送进弹窗、Tab 咬在弹窗内、
 * 关时把焦点还给触发者)全站 20 多个对话框都在依赖,却一直没有兜底。
 *
 * 尤其是「没传 initialFocusRef」这一档:兜底那句 focus() 打在容器 div 上,而 div
 * 不带 tabindex 是不可聚焦的 —— 曾经这句是空操作,焦点留在弹窗外的触发按钮上,
 * 于是 Tab 陷阱根本咬不住(它只在焦点已进容器时生效),一按 Tab 就跑到弹窗背后的
 * 页面里。下面第 1、4 条就是钉住这一档。
 */
const Harness = ({
  withInitialFocus,
  disabledField,
}: {
  withInitialFocus?: boolean
  disabledField?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      {open && (
        <Modal
          onClose={() => setOpen(false)}
          ariaLabel="测试对话框"
          initialFocusRef={withInitialFocus ? inputRef : undefined}
        >
          <input ref={inputRef} aria-label="名称" disabled={disabledField} />
          <button type="button">保存</button>
        </Modal>
      )}
    </>
  )
}

/** fireEvent.click 不会移动焦点,而「关闭时还焦点」正是以此为前提,所以显式聚焦。 */
const openModal = () => {
  const trigger = screen.getByRole('button', { name: '打开' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('Modal 的焦点契约', () => {
  it('没传 initialFocusRef 时,焦点进到对话框容器(而不是留在弹窗外)', () => {
    render(<Harness />)

    openModal()

    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('传了 initialFocusRef 时,焦点直接落在那个输入框上', () => {
    render(<Harness withInitialFocus />)

    openModal()

    expect(screen.getByRole('textbox', { name: '名称' })).toHaveFocus()
  })

  it('关闭后把焦点还给打开它的按钮', () => {
    render(<Harness />)
    const trigger = openModal()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('initialFocusRef 指向 disabled 字段时,退回容器而不是把焦点留在弹窗外', () => {
    render(<Harness withInitialFocus disabledField />)

    openModal()

    // disabled 元素 focus() 是空操作;必须校验后补兜底,否则焦点还在「打开」按钮上,
    // Tab 陷阱咬不住(真实案例:日历设置里主日历的名称框恒 disabled)。
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('焦点停在容器上时按 Shift+Tab 不会跑出弹窗', () => {
    render(<Harness />)
    openModal()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })

    // 兜到弹窗内最后一个可聚焦元素,而不是弹窗背后的页面。
    expect(screen.getByRole('button', { name: '保存' })).toHaveFocus()
  })
})

describe('ModalHeader', () => {
  it('renders a semantic title and delegates the labelled close action', () => {
    const onClose = vi.fn()
    render(
      <ModalHeader
        title="选择联系人"
        subtitle="最多选择 10 人"
        closeLabel="关闭"
        onClose={onClose}
      />
    )

    expect(screen.getByRole('heading', { name: '选择联系人' })).toBeVisible()
    expect(screen.getByText('最多选择 10 人')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('ModalFooter', () => {
  it('uses end alignment by default and supports split picker actions', () => {
    const { rerender } = render(<ModalFooter>保存</ModalFooter>)
    expect(screen.getByText('保存')).toHaveAttribute('data-alignment', 'end')

    rerender(<ModalFooter alignment="space-between">已选 2 人</ModalFooter>)
    expect(screen.getByText('已选 2 人')).toHaveAttribute(
      'data-alignment',
      'space-between'
    )
  })
})

describe('ModalBody', () => {
  it('uses standard padding by default and supports edge-to-edge lists', () => {
    const { rerender } = render(<ModalBody>表单内容</ModalBody>)
    expect(screen.getByText('表单内容')).toHaveAttribute(
      'data-padding',
      'default'
    )

    rerender(
      <ModalBody padding="none" minHeight="8rem" maxHeight="60vh">
        列表内容
      </ModalBody>
    )
    expect(screen.getByText('列表内容')).toHaveAttribute('data-padding', 'none')
    expect(screen.getByText('列表内容')).toHaveStyle({
      minHeight: '8rem',
      maxHeight: '60vh',
    })
  })
})
