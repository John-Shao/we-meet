import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SearchBox } from './SearchBox'

/** ✕ 的默认无障碍名走全局词条,这里回显 key —— 断言只认 key,不认译文。 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

/** 受控包壳:SearchBox 只往外交字符串,状态留在调用点(真实用法就是这样)。 */
const ControlledSearch = ({
  onValueChange,
  clearLabel,
}: {
  onValueChange?: (value: string) => void
  clearLabel?: string
}) => {
  const [value, setValue] = useState('')
  return (
    <SearchBox
      value={value}
      onChange={(next) => {
        setValue(next)
        onValueChange?.(next)
      }}
      placeholder="搜索姓名"
      testId="demo-search"
      clearLabel={clearLabel}
    />
  )
}

describe('SearchBox primitive', () => {
  it('用 type=search,并把占位符同时当作无障碍名', () => {
    render(<ControlledSearch />)

    const input = screen.getByPlaceholderText('搜索姓名')
    expect(input).toHaveAttribute('type', 'search')
    expect(input).toHaveAccessibleName('搜索姓名')
    expect(screen.getByRole('searchbox')).toBe(input)
  })

  it('空的时候不出 ✕,输入内容后右端才出现', async () => {
    const user = userEvent.setup()
    render(<ControlledSearch />)

    expect(screen.queryByTestId('demo-search-clear')).not.toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('搜索姓名'), '通讯')

    expect(screen.getByTestId('demo-search-clear')).toBeInTheDocument()
  })

  it('点 ✕ 清空内容,并把焦点还给输入框', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<ControlledSearch onValueChange={onValueChange} />)

    const input = screen.getByPlaceholderText('搜索姓名')
    await user.type(input, '通讯')
    await user.click(screen.getByTestId('demo-search-clear'))

    expect(input).toHaveValue('')
    expect(onValueChange).toHaveBeenLastCalledWith('')
    // ✕ 是 label 里的交互内容,点它浏览器不会顺手聚焦输入框 —— 「清掉重打」
    // 这个最常见的下一步得能直接敲字,所以清空要自己把焦点还回去。
    expect(input).toHaveFocus()
    // 内容没了,✕ 自己也该退场。
    expect(screen.queryByTestId('demo-search-clear')).not.toBeInTheDocument()
  })

  it('✕ 的无障碍名默认取全局词条,可被 clearLabel 覆盖', () => {
    const { unmount } = render(
      <SearchBox value="通讯" onChange={() => {}} placeholder="搜索" />
    )
    expect(
      screen.getByRole('button', { name: 'clearSearch' })
    ).toBeInTheDocument()

    unmount()
    render(
      <SearchBox
        value="通讯"
        onChange={() => {}}
        placeholder="搜索"
        clearLabel="清空搜索"
      />
    )
    expect(screen.getByRole('button', { name: '清空搜索' })).toBeInTheDocument()
  })

  it('把调用点传进来的 ref 挂在输入框上(Modal 的 initialFocusRef 要用)', () => {
    const ref = createRef<HTMLInputElement>()
    render(
      <SearchBox
        value=""
        onChange={() => {}}
        placeholder="搜索"
        inputRef={ref}
      />
    )

    expect(ref.current).toBe(screen.getByPlaceholderText('搜索'))
  })
})
