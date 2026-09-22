// Human authentication handoff. Never fills passwords, OTP or consent dialogs.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

;(async () => {
  if (!process.env.WEMEET_INSTALLED_EXE) throw new Error('Set WEMEET_INSTALLED_EXE')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: env.WEMEET_INSTALLED_EXE, env })
  const page = await app.firstWindow()
  console.log('READY: installed We-Meet is open; the user must initiate and complete system-browser login.')
  const deadline = Date.now() + 20 * 60 * 1000
  let authenticated = false
  while (Date.now() < deadline) {
    const status = await page.evaluate(() => window.weMeetDesktop?.getStatus()).catch(() => undefined)
    if (status?.auth === 'signed-in') { authenticated = true; break }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (!authenticated) { console.log('PENDING: real login has not been completed; D0 remains unaccepted.'); return }
  const responseStatus = await page.evaluate(async () => (await fetch('/api/v1.0/users/me/')).status)
  const output = path.resolve(__dirname, '../test-results')
  mkdirSync(output, { recursive: true })
  writeFileSync(path.join(output, 'live-login.json'), JSON.stringify({ testedAt: new Date().toISOString(), responseStatus,
    passed: responseStatus === 200, limitation: 'Human completed authentication. Business flows, restart and devices require separate evidence.' }, null, 2))
  console.log(`REAL LOGIN: /users/me/ returned ${responseStatus}. No credentials recorded.`)
  // Keep the authenticated window open for the user's business/device checks.
  await new Promise(resolve => app.once('close', resolve))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
