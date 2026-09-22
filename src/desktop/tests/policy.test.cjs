const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { validateConfig, DEFAULT_CONFIG, externalUrl, sameOrigin, assetPath, callbackCode, CALLBACK } = require('../dist/policy.js')

test('production config requires credential-free HTTPS and an exact origin', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), DEFAULT_CONFIG)
  for (const serviceOrigin of ['http://example.com', 'file:///x', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com/?x=1']) {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, serviceOrigin }))
  }
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, serviceOrigin: 'http://127.0.0.1:1234' }, true).serviceOrigin, 'http://127.0.0.1:1234')
})
test('external link policy rejects executable protocols and credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows', 'ms-settings:privacy', 'https://u:p@example.com', CALLBACK]) assert.equal(externalUrl(url), false)
  for (const url of ['https://example.com', 'mailto:help@example.com']) assert.equal(externalUrl(url), true)
  assert.equal(sameOrigin('https://meet.we-meet.online.evil.test', DEFAULT_CONFIG.serviceOrigin), false)
})
test('asset paths cannot escape the bundle or address Windows streams', () => {
  const root = path.resolve('renderer')
  assert.equal(assetPath(root, '/assets/main.js'), path.join(root, 'assets', 'main.js'))
  for (const url of ['/%2e%2e/secrets', '/a/%2e%2e/secrets', '/%5cWindows', '/C:/Windows', '/file:stream', '/%00', '/%']) assert.equal(assetPath(root, url), undefined)
})
test('callback has exact destination, one state and one code', () => {
  assert.equal(callbackCode(`${CALLBACK}?state=s&code=c`, 's'), 'c')
  for (const url of [`${CALLBACK}?state=x&code=c`, `${CALLBACK}?state=s&state=s&code=c`, `${CALLBACK}?state=s&code=c&code=d`, `${CALLBACK}?state=s&code=c#x`, 'online.we-meet.desktop://evil/callback?state=s&code=c']) assert.throws(() => callbackCode(url, 's'))
})
