// Actual Electron network stack: redirect URL, cookie, CSRF source and body.
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawnSync } = require('node:child_process')

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow, session, net } = require('electron')
  const { forwardRequest } = require('../dist/forward.js')
  const { installRenderer } = require('../dist/renderer.js')
  let server
  app.whenReady().then(async () => {
    let received
    server = http.createServer((req, res) => {
      if (req.url === '/ticket') {
        res.writeHead(302, { location: '/docs/fixture/', 'set-cookie': ['session=fixture; Path=/; HttpOnly', 'csrftoken=fixture; Path=/'] }); res.end(); return
      }
      if (req.url === '/docs/fixture/') {
        res.setHeader('content-type', 'text/html')
        res.end(`<script>fetch('/write',{method:'PATCH',body:'fixture-body',headers:{'X-CSRFToken':'fixture'}}).then(r=>r.text()).then(body=>parent.postMessage({url:location.pathname,body},'*'))</script>`); return
      }
      if (req.url === '/write') {
        const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{received={headers:req.headers,body:Buffer.concat(chunks).toString()};res.end('saved')});return
      }
      res.writeHead(404);res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const docsOrigin = `http://127.0.0.1:${server.address().port}`
    const ownOrigin = 'http://desktop.test'
    const ses = session.fromPartition('forward-smoke')
    // Exercise the same forwarding path used by the installed desktop.
    installRenderer(ses, __dirname, ownOrigin, { epoch: 0, access: async () => undefined }, () => {}, fetch,
      request => forwardRequest(request, options => net.request({ ...options, session: ses })))
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } })
    // A data parent is enough; the child still uses the real HTTP protocol handler.
    await win.loadURL('data:text/html,' + encodeURIComponent(`<script>window.result=new Promise(r=>addEventListener('message',e=>r(e.data)))</script><iframe src="${docsOrigin}/ticket"></iframe>`))
    const result = await win.webContents.executeJavaScript('window.result')
    assert.equal(result.url, '/docs/fixture/')
    assert.equal(result.body, 'saved')
    assert.equal(received.headers.referer, docsOrigin + '/docs/fixture/')
    assert.match(received.headers.cookie, /session=fixture/)
    assert.equal(received.headers['x-csrftoken'], 'fixture')
    assert.equal(received.headers.authorization, undefined)
    assert.equal(received.body, 'fixture-body')
    console.log('Electron forwarding smoke passed: redirect URL, cookies, referrer, CSRF header and PATCH body.')
    server.close();app.exit(0)
  }).catch(error => { console.error(error.message);server?.close();app.exit(1) })
  setTimeout(() => { console.error('Forwarding smoke timed out');server?.close();app.exit(1) }, 20000).unref()
}
