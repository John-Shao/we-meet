const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { installRenderer } = require('../dist/renderer.js')

test('bundle routing, token isolation, API failures and stale-account responses', async () => {
  const origin = 'https://meet.test'
  const root = mkdtempSync(path.join(tmpdir(), 'we-meet-renderer-test-'))
  writeFileSync(path.join(root, 'index.html'), '<html>test</html>')
  writeFileSync(path.join(root, 'main.js'), 'test')
  let handler, call, offline = false, network, changeAccount = false
  const auth = { epoch: 0, access: async () => 'native-token' }
  const session = { protocol: { handle: (_, h) => { handler = h } }, fetch: async (url, init) => {
    call = { url, init }
    if (offline) throw new Error('offline')
    if (changeAccount) auth.epoch++
    return new Response('ok')
  } }
  installRenderer(session, root, origin, auth, online => { network = online }, session.fetch)
  const req = (url, init) => Object.assign(new Request(origin + url, init), { initiatorOrigin: origin })
  await handler(req('/im', { headers: { accept: 'text/html' } }))
  assert.match(call.url, /index\.html$/)
  await handler(req('/main.js')); assert.match(call.url, /main\.js$/)
  assert.equal((await handler(req('/missing.js'))).status, 404)
  await handler(req('/api/v1.0/users/me/', { headers: { authorization: 'Bearer old-renderer', cookie: 'old=account' } }))
  assert.equal(call.init.headers.get('authorization'), 'Bearer native-token')
  assert.equal(call.init.headers.get('cookie'), null)
  assert.equal(call.init.redirect, 'manual')
  assert.equal(network, true)
  const foreign = req('/api/v1.0/users/me/'); foreign.initiatorOrigin = 'https://evil.test'
  assert.equal((await handler(foreign)).status, 403)
  changeAccount = true
  assert.equal((await handler(req('/api/v1.0/users/me/'))).status, 401)
  changeAccount = false; offline = true
  assert.equal((await handler(req('/api/v1.0/users/me/'))).status, 503)
  assert.equal(network, false)
  offline = false
  const docsRequest = new Request('https://docs.test/api/users/self/', {
    method: 'PATCH', referrer: 'https://docs.test/',
    headers: { 'x-csrftoken': 'fixture-csrf' }, body: '{}',
  })
  await handler(docsRequest)
  assert.equal(call.init.headers.get('referer'), 'https://docs.test/')
  assert.equal(call.init.headers.get('x-csrftoken'), 'fixture-csrf')
  assert.equal(call.init.headers.get('authorization'), null)
  assert.equal(call.init.bypassCustomProtocolHandlers, true)
  await handler(new Request('https://docs.test/api/users/self/'))
  assert.equal(call.init.headers.get('referer'), null, 'No synthetic trusted referrer')
})
