// Real Electron navigation cancellation regression; loopback HTML, no credentials.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
;(async () => {
  const root = path.resolve(__dirname, '..')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'we-meet-startup-test-'))
  const modulePath = path.join(root, 'dist/startup.js')
  const entry = path.join(temp, 'main.cjs')
  await fs.writeFile(entry, `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{ globalThis.testWindow=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}}); globalThis.testWindow.loadURL('data:text/html,Ready'); });`)
  let slowStarted
  const started = new Promise(resolve => { slowStarted = resolve })
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') { slowStarted(); return }
    res.setHeader('Content-Type', 'text/html'); res.end('<h1>Replacement navigation completed</h1>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [entry], env })
    await app.firstWindow({ timeout: 15000 })
    await app.evaluate(({ app }, { modulePath, origin }) => {
      const { loadInitialPage } = process.getBuiltinModule('module').createRequire(modulePath)(modulePath)
      globalThis.pendingInitialLoad = loadInitialPage(globalThis.testWindow, origin + '/slow')
    }, { modulePath, origin })
    let readyTimer
    try {
      await Promise.race([started, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Slow navigation did not start')), 10000) })])
    } finally { clearTimeout(readyTimer) }
    const result = await app.evaluate(async () => {
      await globalThis.testWindow.loadURL('data:text/html,<h1>Replacement navigation completed</h1>')
      await globalThis.pendingInitialLoad
      return globalThis.testWindow.webContents.executeJavaScript('document.body.innerText')
    })
    assert.equal(result, 'Replacement navigation completed')
    console.log('Real Electron initial navigation cancellation passed')
  } finally {
    if (app) await app.close().catch(() => {})
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
