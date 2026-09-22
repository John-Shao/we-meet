// Keep the installed acceptance app independent of an interactive REPL lifetime.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const path = require('node:path')
const { createInterface } = require('node:readline')

;(async () => {
  const exe = process.env.WEMEET_INSTALLED_EXE
  if (!exe) throw new Error('Set WEMEET_INSTALLED_EXE')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const output = path.resolve(__dirname, '../test-results')
  mkdirSync(output, { recursive: true })
  const app = await _electron.launch({ executablePath: exe, env })
  const page = await app.firstWindow()
  const redact = value => value.replace(/https?:\/\/\S+/g, '[URL]')
  page.on('pageerror', error => appendFileSync(path.join(output, 'live-ui-errors.log'), redact(error.message) + '\n'))
  const runtime = await app.evaluate(({ app, session }, file) => {
    process.on('uncaughtExceptionMonitor', error => {
      process.getBuiltinModule('fs').appendFileSync(file, new Date().toISOString() + ' ' + app.getVersion() + '\n' + String(error.stack || error.message).replace(/https?:\/\/\S+/g, '[URL]') + '\n')
    })
    if (process.env.WEMEET_TEST_DOWNLOADS === '1') session.fromPartition('persist:we-meet-desktop-v1').on('will-download', (_event, item) => {
      const fs = process.getBuiltinModule('fs')
      const path = process.getBuiltinModule('path')
      const destination = path.join(path.dirname(file), Date.now() + '-' + path.basename(item.getFilename()))
      item.setSavePath(destination)
      item.once('done', (_event, state) => fs.writeFileSync(path.join(path.dirname(file), 'live-download.json'), JSON.stringify({ state, destination, bytes: item.getReceivedBytes() })))
    })
    return { version: app.getVersion(), pid: process.pid }
  }, path.join(output, 'live-main-errors.log'))
  writeFileSync(path.join(output, 'live-ui-session.json'), JSON.stringify({ ...runtime, startedAt: new Date().toISOString() }, null, 2))
  const commands = createInterface({ input: process.stdin })
  commands.on('line', async line => {
    if (line.trim() === 'quit') await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    if (line.trim() === 'status') console.log(await page.evaluate(() => window.weMeetDesktop?.getStatus()).catch(() => 'Page unavailable'))
  })
  console.log(`Acceptance app ready, PID ${runtime.pid}. Commands: status / quit. No tokens logged.`)
  await new Promise(resolve => app.once('close', resolve))
  commands.close()
})().catch(() => { console.error('Acceptance session failed.'); process.exitCode = 1 })
