import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readLocalDrafts, writeLocalDraft } from './inputSync'

describe('local IM drafts', () => {
  beforeEach(() => localStorage.clear())

  it('isolates drafts by account and conversation', () => {
    writeLocalDraft('user-a', 'cid-1', 'first', null)
    writeLocalDraft('user-a', 'cid-2', 'second', null)
    writeLocalDraft('user-b', 'cid-1', 'other account', null)

    expect(readLocalDrafts('user-a')['cid-1'].text).toBe('first')
    expect(readLocalDrafts('user-a')['cid-2'].text).toBe('second')
    expect(readLocalDrafts('user-b')['cid-1'].text).toBe('other account')
  })

  it('keeps reply context and clears an empty draft locally', () => {
    const changed = vi.fn()
    window.addEventListener('im-draft-changed', changed)

    writeLocalDraft('user-a', 'cid-1', 'reply', {
      mid: '42',
      sender: 'Alice',
      summary: 'Original message',
    })
    expect(readLocalDrafts('user-a')['cid-1'].reply?.mid).toBe('42')

    writeLocalDraft('user-a', 'cid-1', '', null)
    expect(readLocalDrafts('user-a')['cid-1']).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)

    window.removeEventListener('im-draft-changed', changed)
  })
})
