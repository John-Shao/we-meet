// Real Electron permission callbacks, isolated profile and loopback renderer.
// Fake media devices/sources; picker always cancels. No screen pixels or input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { _electron } = require('../../frontend/node_modules/@playwright/test');

async function main() {
  const project = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
  const output = await fs.mkdtemp(path.join(project, 'test-results/capture-permissions-'));
  const bootstrap = path.join(output, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `
const e = require('electron');
globalThis.captureFixture = { events: [], allowDevices: false };
e.app.on('session-created', ses => {
  const setPermission = ses.setPermissionRequestHandler.bind(ses);
  ses.setPermissionRequestHandler = handler => setPermission(handler && ((contents, permission, callback, details) => {
    handler(contents, permission, allowed => {
      captureFixture.events.push({kind:'permission',permission,types:details.mediaTypes,mainFrame:details.isMainFrame,allowed});
      callback(allowed);
    }, details);
  }));
  const setDisplay = ses.setDisplayMediaRequestHandler.bind(ses);
  ses.setDisplayMediaRequestHandler = (handler, options) => setDisplay(handler && ((request, callback) => {
    captureFixture.events.push({kind:'display',gesture:request.userGesture});
    return handler(request, callback);
  }), options);
});
e.desktopCapturer.getSources = async () => [{id:'screen:fixture:0',display_id:'123',name:'Fixture'}];
e.dialog.showMessageBox = async (_window, options) => {
  captureFixture.events.push({kind:'dialog',title:options.title});
  return {response:options.title==='媒体设备权限' && captureFixture.allowDevices ? 1 : 0,checkboxChecked:false};
};
e.app.on('browser-window-created', (_event, window) => window.hide());
require(${JSON.stringify(path.join(project, 'dist/main.js'))});
`);
  const html = `<!doctype html><button id="capture">Capture</button><output id="result"></output>
<script>document.querySelector('#capture').onclick=async()=>{try{const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});stream.getTracks().forEach(t=>t.stop());document.querySelector('#result').textContent='captured'}catch(e){document.querySelector('#result').textContent=e.name}}</script>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, WEMEET_USER_DATA: path.join(output, 'profile'),
    WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: origin, WEMEET_RENDERER_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const checks = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap,
      '--no-default-protocol-registration', '--use-fake-device-for-media-stream'], env, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#result')?.textContent);
    assert.notEqual(await page.locator('#result').innerText(), 'captured');
    const captureEvents = await app.evaluate(() => captureFixture.events);
    assert.ok(captureEvents.some(e => e.kind === 'display' && e.gesture));
    assert.equal(captureEvents.filter(e => e.kind === 'dialog' && e.title === '选择要共享的屏幕或窗口').length, 1);
    assert.equal(captureEvents.filter(e => e.kind === 'dialog' && e.title === '媒体设备权限').length, 0);
    checks.push('getDisplayMedia reaches native picker; cancellation yields no track');

    const media = options => page.evaluate(async constraints => {
      try { const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const count = stream.getTracks().length; stream.getTracks().forEach(t => t.stop()); return count;
      } catch (error) { return error.name; }
    }, options);
    assert.equal(await media({ audio: true }), 'NotAllowedError');
    assert.equal(await media({ video: true }), 'NotAllowedError');
    checks.push('screen permission does not grant microphone or camera');
    await app.evaluate(() => { captureFixture.allowDevices = true; });
    assert.equal(await media({ audio: true, video: true }), 2);
    checks.push('explicit device consent still grants requested fake audio/video');

    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'capture-child';
      frame.src = '/child'; frame.allow = 'display-capture'; document.body.append(frame); });
    const before = await app.evaluate(() => captureFixture.events.filter(e => e.kind === 'display').length);
    const child = page.frameLocator('#capture-child');
    await child.getByRole('button', { name: 'Capture', exact: true }).click();
    await child.locator('#result').filter({ hasText: /Error/ }).waitFor();
    assert.equal(await app.evaluate(() => captureFixture.events.filter(e => e.kind === 'display').length), before);
    checks.push('subframe capture denied before source picker');

    const report = { passed: true, at: new Date().toISOString(), checks,
      electron: await app.evaluate(() => process.versions.electron),
      events: await app.evaluate(() => captureFixture.events),
      scope: 'Fake media/sources and cancelled picker; no real capture, login, meeting, input or installer acceptance' };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, checks, output }));
  } catch (error) {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, error: error.message }, null, 2));
    throw error;
  } finally {
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
