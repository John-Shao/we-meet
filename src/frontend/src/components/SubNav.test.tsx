import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SubNavExpandButton, SubNavHeader } from './SubNav'
import { useCollapsibleSubNav } from './useCollapsibleSubNav'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `shell.${key}` }),
}))

const Harness = ({ storageKey }: { storageKey: string }) => {
  const { collapsed, toggle } = useCollapsibleSubNav(storageKey)
  if (collapsed)
    return <SubNavExpandButton onExpand={toggle} testId="nav-expand" />
  return (
    <SubNavHeader
      title="模块标题"
      onCollapse={toggle}
      collapseTestId="nav-collapse"
    />
  )
}

afterEach(() => {
  localStorage.clear()
})

describe('sub navigation chrome', () => {
  it('collapses to a title-bar button, remembers it and expands again', () => {
    render(<Harness storageKey="we-meet:test-nav-collapsed" />)
    fireEvent.click(screen.getByTestId('nav-collapse'))
    expect(screen.getByTestId('nav-expand')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'shell.expand' })
    ).toBeInTheDocument()
    expect(localStorage.getItem('we-meet:test-nav-collapsed')).toBe('1')
    fireEvent.click(screen.getByTestId('nav-expand'))
    expect(screen.getByTestId('nav-collapse')).toBeInTheDocument()
    expect(localStorage.getItem('we-meet:test-nav-collapsed')).toBe('0')
  })

  it('restores the collapsed state from storage', () => {
    localStorage.setItem('we-meet:test-nav-collapsed', '1')
    render(<Harness storageKey="we-meet:test-nav-collapsed" />)
    expect(screen.getByTestId('nav-expand')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-collapse')).not.toBeInTheDocument()
  })

  it('keeps working when storage is unavailable', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('private mode')
      })
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('private mode')
      })
    render(<Harness storageKey="we-meet:test-nav-collapsed" />)
    fireEvent.click(screen.getByTestId('nav-collapse'))
    expect(screen.getByTestId('nav-expand')).toBeInTheDocument()
    expect(getItem).toHaveBeenCalled()
    expect(setItem).toHaveBeenCalled()
    getItem.mockRestore()
    setItem.mockRestore()
  })

  it('renders module actions inside the header', () => {
    render(
      <SubNavHeader title="模块" onCollapse={() => undefined}>
        <button type="button">模块动作</button>
      </SubNavHeader>
    )
    expect(screen.getByRole('button', { name: '模块动作' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'shell.collapse' })
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '模块' })).toBeInTheDocument()
  })
})

it('exposes a stable toggle identity for effects', () => {
  const seen: Array<() => void> = []
  const Probe = () => {
    const { toggle } = useCollapsibleSubNav('we-meet:probe')
    seen.push(toggle)
    return null
  }
  const view = render(<Probe />)
  act(() => view.rerender(<Probe />))
  expect(seen[0]).toBe(seen[1])
})
