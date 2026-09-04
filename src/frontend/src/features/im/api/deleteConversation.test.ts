import type { Client } from '@jusi/light-im-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteConversation } from './deleteConversation'
import { hideConversation } from './hideConversation'

vi.mock('./hideConversation', () => ({
  hideConversation: vi.fn(async () => {}),
}))

describe('deleteConversation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clears existing history before hiding the conversation', async () => {
    const calls: string[] = []
    const client = {
      clearHistory: vi.fn(async () => {
        calls.push('clear')
      }),
    } as unknown as Client
    vi.mocked(hideConversation).mockImplementation(async () => {
      calls.push('hide')
    })

    await deleteConversation(client, 'group-1')

    expect(client.clearHistory).toHaveBeenCalledWith('group-1')
    expect(hideConversation).toHaveBeenCalledWith('group-1')
    expect(calls).toEqual(['clear', 'hide'])
  })

  it('does not hide when clearing history fails', async () => {
    const client = {
      clearHistory: vi.fn(async () => {
        throw new Error('clear failed')
      }),
    } as unknown as Client

    await expect(deleteConversation(client, 'group-1')).rejects.toThrow(
      'clear failed'
    )
    expect(hideConversation).not.toHaveBeenCalled()
  })
})
