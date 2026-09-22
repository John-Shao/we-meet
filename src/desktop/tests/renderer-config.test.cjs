const test = require('node:test')
const assert = require('node:assert/strict')

test('desktop renderer pins production IM and requires explicit IM for custom deployments', async () => {
  const { rendererConfig } = await import('../scripts/renderer-config.mjs')
  assert.deepEqual(rendererConfig({}), { serviceOrigin: 'https://meet.we-meet.online', imBaseUrl: 'https://im.we-meet.online', appTitle: 'We-Meet' })
  assert.throws(() => rendererConfig({ WEMEET_SERVICE_URL: 'https://meet.example.com' }), /WEMEET_IM_URL/)
  assert.equal(rendererConfig({ WEMEET_SERVICE_URL: 'https://meet.example.com', WEMEET_IM_URL: 'https://im.example.com' }).imBaseUrl, 'https://im.example.com')
  for (const invalid of ['http://im.example.com', 'https://user:secret@im.example.com', 'https://im.example.com/api', 'https://im.example.com?key=x']) {
    assert.throws(() => rendererConfig({ WEMEET_IM_URL: invalid }), /HTTPS origins/)
  }
})
