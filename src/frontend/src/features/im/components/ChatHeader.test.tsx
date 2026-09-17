import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChatHeader } from './ChatHeader'

describe('ChatHeader', () => {
  it('keeps title and meta on one row with the avatar leading', () => {
    render(
      <ChatHeader
        title="前端开发组"
        avatar={<span data-testid="avatar-tile" />}
        meta="5 人"
      />
    )
    // 头像 / 标题 / 备注 都在,且同一行(结构上都在标题栏那一层)。
    expect(screen.getByTestId('chat-header-avatar')).toContainElement(
      screen.getByTestId('avatar-tile')
    )
    expect(screen.getByTestId('chat-direct-title')).toHaveTextContent(
      '前端开发组'
    )
    expect(screen.getByTestId('chat-header-meta')).toHaveTextContent('5 人')
  })

  it('uses a settings button only when the group settings panel exists', () => {
    const onOpenSettings = vi.fn()
    const view = render(
      <ChatHeader title="前端开发组" avatar={<span />} meta="5 人" />
    )
    expect(screen.queryByTestId('chat-group-title')).not.toBeInTheDocument()
    view.rerender(
      <ChatHeader
        title="前端开发组"
        avatar={<span />}
        meta="5 人"
        onOpenSettings={onOpenSettings}
        settingsLabel="manage.settings"
      />
    )
    const title = screen.getByTestId('chat-group-title')
    expect(title).toHaveAttribute('aria-label', 'manage.settings')
    fireEvent.click(title)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('omits the meta slot when there is nothing to say', () => {
    render(<ChatHeader title="夜来香" avatar={<span />} />)
    expect(screen.queryByTestId('chat-header-meta')).not.toBeInTheDocument()
  })

  it('renders the module actions to the right of the title row', () => {
    render(
      <ChatHeader title="前端开发组" avatar={<span />} meta="5 人">
        <button type="button">发起群聊</button>
      </ChatHeader>
    )
    expect(screen.getByRole('button', { name: '发起群聊' })).toBeInTheDocument()
  })
})
