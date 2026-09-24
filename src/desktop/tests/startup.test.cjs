const test = require('node:test')
const assert = require('node:assert/strict')
const { loadInitialPage } = require('../dist/startup')

test('navigation cancellation does not masquerade as a broken installation', async () => {
  for (const failure of [{ code: 'ERR_ABORTED' }, { errno: -3 }]) {
    await loadInitialPage({ loadURL: async () => { throw failure } }, 'https://example.invalid')
  }
  // Real failures still reach the application's startup failure path.
  for (const failure of [Object.assign(new Error('missing renderer'), { code: 'ERR_FILE_NOT_FOUND', errno: -6 }), new Error('setup failed')]) {
    await assert.rejects(loadInitialPage({ loadURL: async () => { throw failure } }, 'https://example.invalid'), error => error === failure)
  }
})
