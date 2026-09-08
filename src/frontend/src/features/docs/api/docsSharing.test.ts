import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { addDocMembers, grantChatAccess, memberIds } from './docsSharing'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
const fetch = vi.mocked(fetchApi)
beforeEach(() => vi.resetAllMocks())

describe('Docs sharing acknowledgements', () => {
  it('invites by user ID, retains missing/failed results, and accepts existing access', async () => {
    fetch.mockResolvedValue({
      identity: 'user_id',
      role: 'reader',
      results: [
        { user_id: 'a', status: 'added' },
        { user_id: 'b', status: 'existing' },
        { user_id: 'c', status: 'failed' },
      ],
    })
    expect(await addDocMembers('doc', ['a', 'b', 'c', 'd'], 'reader')).toEqual([
      'c',
      'd',
    ])
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
      doc_id: 'doc',
      user_ids: ['a', 'b', 'c', 'd'],
      role: 'reader',
    })
  })
  it('does not accept duplicate or legacy email invitation acknowledgements', async () => {
    fetch.mockResolvedValueOnce({
      identity: 'email',
      role: 'reader',
      results: [],
    })
    await expect(addDocMembers('doc', ['a'], 'reader')).rejects.toThrow()
    fetch.mockResolvedValueOnce({
      identity: 'user_id',
      role: 'reader',
      results: [
        { user_id: 'a', status: 'added' },
        { user_id: 'a', status: 'added' },
      ],
    })
    expect(await addDocMembers('doc', ['a'], 'reader')).toEqual(['a'])
  })
  it.each([
    { scoped: true, complete: false, role: 'editor' },
    { scoped: true, complete: true, role: 'reader' },
    { complete: true, role: 'editor' },
  ])('rejects incomplete or mismatched chat grants: %j', async (response) => {
    fetch.mockResolvedValue(response)
    await expect(grantChatAccess('doc', 'cid', 'editor')).rejects.toThrow()
  })
  it('accepts a confirmed scoped grant and rejects malformed rosters', async () => {
    fetch.mockResolvedValueOnce({
      scoped: true,
      complete: true,
      role: 'editor',
    })
    await expect(
      grantChatAccess('doc', 'cid', 'editor')
    ).resolves.toBeUndefined()
    fetch.mockResolvedValueOnce({ user_ids: [null] })
    await expect(memberIds('doc')).rejects.toThrow()
  })
})
