import { expect, it } from 'vitest'
import { parseShareRequest } from './shareRequest'

it('requires the configured origin and the current Docs iframe', () => {
  const data = {
    type: 'wemeet-share-doc',
    docId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  }
  const event = new MessageEvent('message', {
    origin: 'https://docs.test',
    source: window,
    data,
  })
  expect(parseShareRequest(event, 'https://evil.test', window)).toBeNull()
  expect(parseShareRequest(event, 'https://docs.test', null)).toBeNull()
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  expect(
    parseShareRequest(event, 'https://docs.test', iframe.contentWindow)
  ).toBeNull()
  iframe.remove()
})

it('uses a canonical document link, bounds titles, and ignores truthy non-boolean management flags', () => {
  const data = {
    type: 'wemeet-share-doc',
    docId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    title: 'x'.repeat(500),
    url: 'javascript:alert(1)',
    role: 'owner',
    canManage: 'true',
  }
  const parsed = parseShareRequest(
    new MessageEvent('message', {
      origin: 'https://docs.test',
      source: window,
      data,
    }),
    'https://docs.test',
    window
  )
  expect(parsed?.url).toBe(`https://docs.test/docs/${data.docId}/`)
  expect(parsed?.title.length).toBe(255)
  expect(parsed?.role).toBe('reader')
  expect(parsed?.canManage).toBe(false)
})
