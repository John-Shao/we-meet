import { describe, expect, it, vi } from 'vitest'
import { deliverDocument } from './shareDelivery'

const target = (cid: string) => ({ cid, sent: false, authorized: false })

describe('document delivery recovery', () => {
  it('retries failed grants without repeating any confirmed card', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const grant = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const first = await deliverDocument(
      [target('a'), target('b')],
      send,
      grant,
      vi.fn()
    )
    expect(first[0]).toMatchObject({
      sent: true,
      authorized: false,
      error: 'access',
    })
    const retried = await deliverDocument(first, send, grant, vi.fn())
    expect(send).toHaveBeenCalledTimes(2)
    expect(grant).toHaveBeenCalledTimes(3)
    expect(
      retried.every((item) => item.sent && item.authorized && !item.error)
    ).toBe(true)
  })
  it('does not grant access when sending is unconfirmed, and continues other chats', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(undefined)
    const grant = vi.fn().mockResolvedValue(undefined)
    const results = await deliverDocument(
      [target('a'), target('b')],
      send,
      grant,
      vi.fn()
    )
    expect(results[0].error).toBe('send')
    expect(grant).toHaveBeenCalledExactlyOnceWith('b')
  })
  it('allows card-only delivery without falsely reporting authorization', async () => {
    const results = await deliverDocument(
      [target('a')],
      vi.fn().mockResolvedValue(undefined),
      null,
      vi.fn()
    )
    expect(results[0]).toMatchObject({ sent: true, authorized: false })
  })
  it('stops further side effects when the share flow is unmounted', async () => {
    let active = true
    const send = vi.fn().mockImplementation(() => {
      active = false
      return Promise.resolve()
    })
    const grant = vi.fn()
    await deliverDocument(
      [target('a'), target('b')],
      send,
      grant,
      vi.fn(),
      () => active
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(grant).not.toHaveBeenCalled()
  })
})
