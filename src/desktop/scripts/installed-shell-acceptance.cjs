const { _electron } = require('../../frontend/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const output = path.resolve(__dirname, '../../../.work-acceptance/work-cross-device-20261007');
  const installed = fs.realpathSync(path.join(output, 'installed'));
  assert.ok(installed.startsWith(output + path.sep));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.join(installed, 'We-Meet Work Acceptance.exe'), env, timeout: 30000 });
  try {
    const page = await app.firstWindow();
    const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData') }));
    assert.equal(info.packaged, true);
    assert.ok(info.appPath.startsWith(installed + path.sep));
    assert.match(info.userData, /(?:we-meet-work-acceptance|We-Meet Work Acceptance)$/);
    assert.equal(info.version, process.env.WEMEET_ACCEPTANCE_EXPECTED_VERSION);
    const sentinel = path.join(info.userData, 'installation-acceptance-sentinel.txt');
    if (info.version.endsWith('.1') && !fs.existsSync(sentinel)) fs.writeFileSync(sentinel, 'isolated-installation-state');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'isolated-installation-state');
    await page.waitForFunction(() => !!window.weMeetDesktop);
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim(), { timeout: 45000 });
    assert.equal((await page.evaluate(() => window.weMeetDesktop.getStatus())).auth, 'signed-out');
    const stage = process.env.WEMEET_ACCEPTANCE_STAGE || info.version;
    assert.match(stage, /^[a-zA-Z0-9.-]+$/);
    await page.screenshot({ path: path.join(output, `installed-${stage}.png`), animations: 'disabled' });
    fs.writeFileSync(path.join(output, `installed-${stage}.json`), JSON.stringify({ passed: true, ...info, sentinel_preserved: true, limitation: 'Distinct acceptance application ID/name; public config read only, no real login or clean Windows machine.' }, null, 2));
    console.log('Installed application startup and preserved isolated state:', info.version);
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
