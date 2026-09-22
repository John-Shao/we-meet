const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { DesktopAuth } = require('../dist/auth.js')
const { CALLBACK } = require('../dist/policy.js')

function store(initial) {
  let value = initial
  return { read: () => value, write: v => { value = v }, clear: () => { value = undefined } }
}

test('PKCE, signed ID token, duplicate callback and logout fencing', async t => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose')
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
  let nonce, challenge, count = 0, release
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks' }))
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }))
    if (req.url === '/token') {
      count++
      const parts = []; for await (const p of req) parts.push(p)
      const body = new URLSearchParams(Buffer.concat(parts).toString())
      assert.equal(body.get('client_id'), 'desktop')
      assert.equal(body.get('redirect_uri'), CALLBACK)
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge)
      if (body.get('code') === 'delayed') await new Promise(resolve => { release = resolve })
      const id_token = await new SignJWT({ nonce: body.get('code') === 'wrong-nonce' ? 'wrong' : nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject('user-A').setIssuer(issuer).setAudience('desktop').setIssuedAt().setExpirationTime('5m').sign(privateKey)
      return res.end(JSON.stringify({ access_token: 'access-test', refresh_token: 'refresh-test', token_type: 'Bearer', expires_in: 300, id_token }))
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const issuer = `http://127.0.0.1:${server.address().port}`
  const storage = store()
  const config = { serviceOrigin: 'https://meet.test', issuer, clientId: 'desktop' }
  const auth = new DesktopAuth(config, storage)
  const begin = async () => {
    const url = new URL(await auth.begin()); nonce = url.searchParams.get('nonce'); challenge = url.searchParams.get('code_challenge')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('response_type'), 'code')
    return url.searchParams.get('state')
  }
  const state = await begin()
  await assert.rejects(auth.complete(`${CALLBACK}?state=wrong&code=c`))
  assert.equal(count, 0)
  await auth.complete(`${CALLBACK}?state=${state}&code=c`)
  assert.equal(auth.epoch, 1)
  assert.equal(await auth.access(), 'access-test')
  await assert.rejects(auth.complete(`${CALLBACK}?state=${state}&code=c`))
  assert.equal(count, 1)
  assert.equal(new DesktopAuth(config, storage).signedIn, true)
  assert.equal(new DesktopAuth({ ...config, serviceOrigin: 'https://other.test' }, storage).signedIn, false)
  const invalidNonceState = await begin()
  await assert.rejects(auth.complete(`${CALLBACK}?state=${invalidNonceState}&code=wrong-nonce`))
  assert.equal(auth.epoch, 1)
  assert.equal(await auth.access(), 'access-test')
  const next = await begin()
  const completing = auth.complete(`${CALLBACK}?state=${next}&code=delayed`)
  while (!release) await new Promise(resolve => setTimeout(resolve, 5))
  auth.clear(); release()
  await assert.rejects(completing)
  assert.equal(auth.signedIn, false)
  assert.equal(storage.read(), undefined)
})

test('refresh coalesces, revoked grants clear state, transient errors preserve it', async () => {
  const config = { serviceOrigin: 'https://meet.test', issuer: 'https://id.test', clientId: 'desktop' }
  const saved = JSON.stringify({ ...config, tokens: { access: 'old', refresh: 'old-refresh', subject: 'u', expiresAt: 1 } })
  let calls = 0, mode = 'ok'
  const fetcher = async url => {
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: config.issuer, authorization_endpoint: config.issuer + '/auth', token_endpoint: config.issuer + '/token', jwks_uri: config.issuer + '/jwks' })
    calls++
    if (mode === 'revoked') return Response.json({ error: 'invalid_grant' }, { status: 400 })
    if (mode === 'offline') throw new Error('offline')
    return Response.json({ access_token: 'new', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 300 })
  }
  const auth = new DesktopAuth(config, store(saved), fetcher)
  assert.deepEqual(await Promise.all([auth.access(), auth.access(), auth.access()]), ['new', 'new', 'new'])
  assert.equal(calls, 1)
  mode = 'offline'
  let expired = 0
  const offline = new DesktopAuth(config, store(saved), fetcher, () => expired++)
  await assert.rejects(offline.access()); assert.equal(offline.signedIn, true)
  assert.equal(expired, 0)
  mode = 'revoked'
  const revoked = new DesktopAuth(config, store(saved), fetcher, () => expired++)
  assert.deepEqual(await Promise.all([revoked.access(), revoked.access()]), [undefined, undefined])
  assert.equal(revoked.signedIn, false)
  assert.equal(expired, 1)
})

test('issuer mismatch and endpoint substitution are rejected before opening a browser', async () => {
  const config = { serviceOrigin: 'https://meet.test', issuer: 'https://id.test', clientId: 'desktop' }
  for (const issuer of ['https://evil.test', config.issuer]) {
    const auth = new DesktopAuth(config, store(), async () => Response.json({ issuer, authorization_endpoint: 'https://evil.test/auth', token_endpoint: 'https://evil.test/token', jwks_uri: 'https://evil.test/jwks' }))
    await assert.rejects(auth.begin())
  }
})
