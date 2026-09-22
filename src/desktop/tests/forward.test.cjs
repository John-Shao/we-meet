const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough, Readable } = require('node:stream')
const { forwardRequest } = require('../dist/forward.js')

test('foreign redirects remain visible and preserve separate session cookies without native credentials', async () => {
  const outgoing = new PassThrough()
  const sent = new Map()
  outgoing.setHeader = (k, v) => sent.set(k, v)
  outgoing.abort = () => outgoing.destroy()
  let options
  const promise = forwardRequest(new Request('https://docs.test/ticket/', { headers: { referer: 'https://meet.test/' } }), opts => { options = opts; return outgoing })
  outgoing.emit('redirect', 302, 'GET', 'https://docs.test/docs/example/', { 'set-cookie': ['session=one; Path=/', 'csrf=two; Path=/'] })
  outgoing.emit('error', new Error('Redirect was cancelled'))
  const response = await promise
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://docs.test/docs/example/')
  assert.equal(response.headers.getSetCookie().length, 2)
  assert.equal(options.redirect, 'manual')
  assert.equal(options.bypassCustomProtocolHandlers, true)
  assert.equal(sent.get('authorization'), undefined)
  assert.equal(sent.get('referer'), 'https://meet.test/')
})

test('foreign response streams bytes and request bodies without buffering the entire file', async () => {
  const outgoing = new PassThrough()
  outgoing.setHeader = () => {}
  outgoing.abort = () => outgoing.destroy()
  const chunks = []
  outgoing.on('data', chunk => chunks.push(chunk))
  const promise = forwardRequest(new Request('https://docs.test/upload', { method: 'POST', body: 'fixture' }), () => outgoing)
  await new Promise(resolve => outgoing.once('finish', resolve))
  assert.equal(Buffer.concat(chunks).toString(), 'fixture')
  const incoming = Readable.from([Buffer.from('downloaded')])
  incoming.statusCode = 200
  incoming.headers = { 'content-encoding': ['gzip'], 'content-length': ['100'] }
  outgoing.emit('response', incoming)
  const response = await promise
  assert.equal(await response.text(), 'downloaded')
  assert.equal(response.headers.has('content-encoding'), false)
  assert.equal(response.headers.has('content-length'), false)
})
