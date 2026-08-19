import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from '@/api/fetchApi'

import {
  acceptExternalContactRequest,
  fetchExternalContactRequests,
  fetchExternalContacts,
  removeExternalContact,
  searchExternalAccounts,
  sendExternalContactRequest,
} from './externalContacts'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))

describe('external contacts API', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset().mockResolvedValue([])
  })

  it('lists accepted contacts and pending requests separately', async () => {
    await fetchExternalContacts()
    await fetchExternalContactRequests()

    expect(fetchApi).toHaveBeenNthCalledWith(1, '/directory/external-contacts/')
    expect(fetchApi).toHaveBeenNthCalledWith(
      2,
      '/directory/external-contacts/requests/'
    )
  })

  it('uses phone or email only as an encoded account-search query', async () => {
    await searchExternalAccounts('  partner+calendar@example.com  ')

    expect(fetchApi).toHaveBeenCalledWith(
      '/directory/external-contacts/search/?q=partner%2Bcalendar%40example.com'
    )
  })

  it('sends, accepts and removes a relationship by real account ids', async () => {
    await sendExternalContactRequest('user/id')
    await acceptExternalContactRequest('relationship/id')
    await removeExternalContact('relationship/id')

    expect(fetchApi).toHaveBeenNthCalledWith(
      1,
      '/directory/external-contacts/requests/',
      {
        method: 'POST',
        body: JSON.stringify({ target_user_id: 'user/id' }),
      }
    )
    expect(fetchApi).toHaveBeenNthCalledWith(
      2,
      '/directory/external-contacts/relationship%2Fid/accept/',
      { method: 'POST' }
    )
    expect(fetchApi).toHaveBeenNthCalledWith(
      3,
      '/directory/external-contacts/relationship%2Fid/',
      { method: 'DELETE' }
    )
  })
})
