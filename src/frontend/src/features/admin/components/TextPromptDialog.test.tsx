import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TextPromptDialog } from './TextPromptDialog'

/**
 * 钉住「打开即可打字」这一档在 **react-aria 壳** 下真的成立。
 *
 * 为什么值得单独一条:`primitives/Dialog` 走的是 RAC 的 `useDialog`,它默认把焦点放在
 * 对话框**容器**上(源码原话:"Focus the dialog itself on mount, unless a child element
 * is already focused"),而不是首个可聚焦元素 —— 一度被误认为"RAC 会自动聚焦第一个字段"
 * 而漏掉这一类。唯一的覆盖手段是子元素 `autoFocus`,能否生效取决于 RAC 那句
 * `isFocusedWithin` 检查的时序,所以用测试钉死,而不是靠推理。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('TextPromptDialog', () => {
  it('打开时焦点直接在唯一的输入框里(而不是停在对话框容器上)', () => {
    render(
      <TextPromptDialog
        isOpen
        title="新建用户组"
        confirmLabel="创建"
        onSubmit={() => {}}
        onClose={() => {}}
      />
    )

    expect(screen.getByRole('textbox', { name: '新建用户组' })).toHaveFocus()
  })

  it('带初始值时也聚焦(重命名场景),且值已带入', () => {
    render(
      <TextPromptDialog
        isOpen
        title="重命名"
        initialValue="研发组"
        confirmLabel="保存"
        onSubmit={() => {}}
        onClose={() => {}}
      />
    )

    const input = screen.getByRole('textbox', { name: '重命名' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('研发组')
  })
})
