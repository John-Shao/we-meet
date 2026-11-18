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
test('the optional work section is a closed, secure gateway deployment', () => {
  // Absent work leaves the driver dormant — the shipped default.
  assert.equal(validateConfig(DEFAULT_CONFIG).work, undefined)
  const work = { gatewayOrigin: 'https://gw.we-meet.online:8443', serverName: 'gw.we-meet.online', caPemPath: path.resolve('ca.pem') }
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, work }).work, work)
  for (const gatewayOrigin of ['http://gw.example.test', 'https://u:p@gw.example.test', 'file:///x']) {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, work: { ...work, gatewayOrigin } }))
  }
  // Like the issuer, the gateway origin is normalized: a path is dropped, never forwarded.
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, work: { ...work, gatewayOrigin: 'https://gw.example.test/path' } }).work.gatewayOrigin, 'https://gw.example.test')
  for (const serverName of ['', 'gw example', 'gw/example', 'a'.repeat(254), 42]) {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, work: { ...work, serverName } }))
  }
  for (const caPemPath of ['ca.pem', 'relative/ca.pem', '', 42]) {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, work: { ...work, caPemPath } }))
  }
  const dev = validateConfig({ ...DEFAULT_CONFIG, serviceOrigin: 'http://127.0.0.1:8000', work: { ...work, gatewayOrigin: 'http://localhost:9443' } }, true)
  assert.equal(dev.work.gatewayOrigin, 'http://localhost:9443')
})
