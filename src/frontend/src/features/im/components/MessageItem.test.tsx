import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { MessageItem } from './MessageItem'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const message = (overrides: Partial<Message> = {}): Message => ({
  mid: 1,
  cid: 'conversation-1',
  sender_uid: 'peer-uid',
  seq: 1,
  content_type: 'text',
  body: '你好',
  ts: 1_700_000_000_000,
  ...overrides,
})

describe('MessageItem appearance', () => {
  it('uses a visible themed surface for an incoming message bubble', () => {
    render(<MessageItem message={message()} isOwn={false} senderName="W008" />)

    expect(screen.getByTestId('im-msg-bubble')).toHaveClass(
      css({ backgroundColor: 'surface.muted' })
    )
  })

  it('does not add a second bubble surface around a rich card', () => {
    render(
      <MessageItem
        message={message({
          content_type: 'rich-card',
          body: JSON.stringify({
            version: 1,
            header: { title: '任务已完成', theme: 'success' },
            blocks: [
              { type: 'text', spans: [{ tag: 'text', text: '培训计划' }] },
            ],
          }),
        })}
        isOwn={false}
        senderName="任务助手"
      />
    )

    const bubble = screen.getByTestId('im-msg-bubble')
    expect(bubble).toHaveClass(css({ backgroundColor: 'transparent' }))
    expect(bubble).toHaveClass(css({ paddingX: '0' }))
    expect(bubble).toHaveClass(css({ paddingY: '0' }))
    expect(screen.getByTestId('rich-card')).toBeInTheDocument()
  })

  it.each([
    { isOwn: false, name: 'W008', avatar: '/peer-avatar.png' },
    { isOwn: true, name: 'W009', avatar: '/self-avatar.png' },
  ])('shows the sender avatar on a call record', ({ isOwn, name, avatar }) => {
    render(
      <MessageItem
        message={message({
          sender_uid: isOwn ? 'self-uid' : 'peer-uid',
          content_type: 'call-log',
          body: JSON.stringify({
            media: 'audio',
            result: 'completed',
            duration: 62,
          }),
        })}
        isOwn={isOwn}
        senderName={name}
        senderAvatarUrl={avatar}
      />
    )

    const row = screen.getByTestId('im-msg-calllog')
    expect(within(row).getByRole('button', { name })).toBeInTheDocument()
    expect(row.querySelector('img')).toHaveAttribute('src', avatar)
  })
})
