import { fireEvent, render, screen } from '@testing-library/react'
import type { ConversationSummary } from '@jusi/light-im-sdk'
import { describe, expect, it, vi } from 'vitest'

import { ConversationList } from './ConversationList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

const direct = {
  cid: 'direct-1',
  type: 'direct',
  members: ['me', 'peer'],
  unread_count: 0,
  pinned: false,
  muted: false,
} as unknown as ConversationSummary

const group = {
  cid: 'group-1',
  type: 'group',
  name: 'Team',
  members: ['me', 'peer'],
  unread_count: 0,
  pinned: true,
  muted: true,
} as unknown as ConversationSummary

const mount = (conversations: ConversationSummary[]) => {
  const onDelete = vi.fn()
  const onTogglePinned = vi.fn()
  const onToggleMuted = vi.fn()

  render(
    <ConversationList
      conversations={conversations}
      selectedCID={null}
      onSelect={() => {}}
      nameOf={(conversation) => conversation.name || conversation.cid}
      onDelete={onDelete}
      onTogglePinned={onTogglePinned}
      onToggleMuted={onToggleMuted}
    />
  )

  return { onDelete, onTogglePinned, onToggleMuted }
}

describe('ConversationList context menu', () => {
  it('replaces the delete shortcut with direct-conversation actions', () => {
    const handlers = mount([direct])

    expect(screen.queryByTestId('conv-del-direct-1')).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByTestId('conv-item-direct-1'), {
      clientX: 120,
      clientY: 80,
    })

    expect(screen.getByText('list.contextMenu.pin')).toBeInTheDocument()
    expect(screen.getByText('list.contextMenu.mute')).toBeInTheDocument()
    expect(screen.getByText('list.contextMenu.delete')).toBeInTheDocument()
    expect(screen.queryByText('list.contextMenu.leave')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('conv-ctx-pin'))
    expect(handlers.onTogglePinned).toHaveBeenCalledWith(direct)

    fireEvent.contextMenu(screen.getByTestId('conv-item-direct-1'))
    fireEvent.click(screen.getByTestId('conv-ctx-mute'))
    expect(handlers.onToggleMuted).toHaveBeenCalledWith(direct)

    fireEvent.contextMenu(screen.getByTestId('conv-item-direct-1'))
    fireEvent.click(screen.getByTestId('conv-ctx-delete'))
    expect(handlers.onDelete).toHaveBeenCalledWith(direct)
  })

  it('shows inverse settings and leave for a muted, pinned group', () => {
    const handlers = mount([group])

    fireEvent.keyDown(screen.getByTestId('conv-item-group-1'), {
      key: 'F10',
      shiftKey: true,
    })

    expect(screen.getByText('list.contextMenu.unpin')).toBeInTheDocument()
    expect(screen.getByText('list.contextMenu.unmute')).toBeInTheDocument()
    expect(screen.getByText('list.contextMenu.leave')).toBeInTheDocument()
    expect(
      screen.queryByText('list.contextMenu.delete')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('conv-ctx-pin'))
    expect(handlers.onTogglePinned).toHaveBeenCalledWith(group)

    fireEvent.contextMenu(screen.getByTestId('conv-item-group-1'))
    fireEvent.click(screen.getByTestId('conv-ctx-mute'))
    expect(handlers.onToggleMuted).toHaveBeenCalledWith(group)

    fireEvent.contextMenu(screen.getByTestId('conv-item-group-1'))
    fireEvent.click(screen.getByTestId('conv-ctx-leave'))
    expect(handlers.onDelete).toHaveBeenCalledWith(group)
  })
})
