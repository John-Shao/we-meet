import { describe, expect, it } from 'vitest'
import type { Message } from '@jusi/light-im-sdk'

import { messageTaskDescription, messageTaskSource } from './messageTask'

const message = (patch: Partial<Message> = {}): Message => ({
  mid: 42,
  cid: 'conversation-1',
  sender_uid: 'user-2',
  seq: 7,
  content_type: 'text',
  body: '  Review the launch checklist.  ',
  ts: 1788571200000,
  ...patch,
})

describe('messageTaskDescription', () => {
  it('uses text as the editable task description', () => {
    expect(messageTaskDescription(message())).toBe(
      'Review the launch checklist.'
    )
  })

  it('flattens rich text and quote replies without using their JSON body', () => {
    expect(
      messageTaskDescription(
        message({
          content_type: 'rich-text',
          body: JSON.stringify({
            v: 1,
            content: [
              [{ tag: 'text', text: 'Ship ' }],
              [{ tag: 'at', uid: 'user-3', name: 'Lin' }],
            ],
          }),
        })
      )
    ).toBe('Ship @Lin')
    expect(
      messageTaskDescription(
        message({
          content_type: 'quote',
          body: JSON.stringify({ text: 'Confirm the release date' }),
        })
      )
    ).toBe('Confirm the release date')
  })

  it('rejects recalled and non-text messages', () => {
    expect(messageTaskDescription(message({ recalled: true }))).toBeNull()
    expect(
      messageTaskDescription(message({ content_type: 'image' }))
    ).toBeNull()
  })

  it('clamps the description to the task API limit', () => {
    expect(
      messageTaskDescription(message({ body: 'a'.repeat(5100) }))
    ).toHaveLength(5000)
  })
})

it('keeps structured message provenance separate from the description', () => {
  expect(messageTaskSource(message(), 'Original snapshot')).toEqual({
    cid: 'conversation-1',
    mid: '42',
    seq: 7,
    sender_uid: 'user-2',
    sent_at: 1788571200000,
    content_type: 'text',
    snapshot: 'Original snapshot',
  })
})
