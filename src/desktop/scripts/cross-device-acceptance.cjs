// Both real UIs share the isolated Django bridge. Authentication/dialog choices are fixtures.
const { _electron } = require('../../frontend/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const origin = process.env.WORK_COORDINATION_URL;
  if (origin !== 'http://127.0.0.1:48761' || !process.env.WE_MEET_LOCAL_KEY_FILE || process.env.WORK_LOCAL_ALLOW_PAID !== '1') throw Error('Isolated API and explicit model opt-in required');
  const output = path.resolve(process.env.WORK_CROSS_DEVICE_OUTPUT);
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cross-device-'));
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, '本地 工作空间');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'input.txt'), 'cross-device-marker-20261007\n');
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const checkpoint = name => fs.writeFileSync(path.join(output, 'checkpoint.txt'), name);
  async function launch() {
    checkpoint('launching');
    app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env, timeout: 30000 });
    return app.firstWindow();
  }
  async function stop() {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
      await app.close().catch(() => {}); app = undefined;
    }
  }
  try {
    let page = await launch();
    await page.waitForFunction(() => !!window.weMeetDesktop);
    checkpoint('seeding');
    await app.evaluate(({ app, safeStorage }, fixture) => {
      if (app.getPath('userData') !== fixture.profile) throw Error('Wrong profile');
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
      fs.writeFileSync(path.join(fixture.profile, 'session-v1.enc'), safeStorage.encryptString(JSON.stringify({
        issuer: fixture.origin, serviceOrigin: fixture.origin, clientId: 'desktop',
        tokens: { access: 'isolated-test-account', refresh: 'isolated-test-refresh', subject: 'cross-device-account', expiresAt: Date.now() + 3600000 },
      })));
    }, { profile, origin });
    checkpoint('stopping-initial');
    await stop(); page = await launch(); page.setDefaultTimeout(20000);
    checkpoint('configuring');
    page.on('pageerror', e => fs.writeFileSync(path.join(output, 'renderer-error.txt'), String(e.stack || e)));
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? fixture.workspace : fixture.keyFile] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, { workspace, keyFile: process.env.WE_MEET_LOCAL_KEY_FILE });
    await page.goto(origin + '/work?view=new');
    checkpoint('waiting-work-route');
    try { await page.getByRole('heading', { name: '本地工作空间', exact: true }).waitFor(); }
    catch (e) {
      fs.writeFileSync(path.join(output, 'route-diagnostic.json'), JSON.stringify(await page.evaluate(async () => ({ url: location.href, text: document.body.innerText.slice(0, 4000), status: await window.weMeetDesktop?.getStatus() })), null, 2));
      await page.screenshot({ path: path.join(output, 'route-error.png') }); throw e;
    }
    await page.getByRole('button', { name: '配置本机 dsh', exact: true }).click();
    await page.getByText(/已连接 dsh/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '选择本地文件夹', exact: true }).click();
    const remoteToggle = page.getByRole('checkbox', { name: /^允许远程请求进入此工作空间待办/ });
    await remoteToggle.click();
    // Change only the display label through the real business endpoint; no native paths sent.
    const request = async (endpoint, body) => {
      const response = await fetch(origin + '/api/v1.0/work/' + endpoint, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer isolated-test-account', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
      assert.equal(response.ok, true, endpoint); return response.json();
    };
    let published;
    for (let n = 0; n < 100; n++) {
      const listing = await request('local/workspaces/'); published = listing.workspaces.find(w => w.enabled);
      if (published) break; await page.waitForTimeout(100);
    }
    assert.ok(published);
    await request('local/workspaces/', { device_id: published.device_id, workspace_id: published.id, label: 'Cross-device workspace', model: published.model, enabled: true });
    fs.writeFileSync(path.join(output, 'desktop-ready.json'), JSON.stringify({ workspace_id: published.id }));
    const take = page.getByRole('button', { name: '审阅并领取', exact: true }).first();
    await take.waitFor({ timeout: 90000 });
    assert.deepEqual(await page.evaluate(() => window.weMeetDesktop.localWork.list()), []);
    await take.click();
    let job, runId, approvalCount = 0;
    const reviewed = new Set();
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      runId = new URL(page.url()).searchParams.get('localRun');
      job = runId ? await page.evaluate(id => window.weMeetDesktop.localWork.get(id), runId) : null;
      if (job && !['queued', 'running'].includes(job.state)) break;
      if (job?.approvals?.length) {
        fs.writeFileSync(path.join(output, 'pending-approval.json'), JSON.stringify({ run_id: runId, workspace, approvals: job.approvals }, null, 2));
        const decisionFile = path.join(output, 'approved-fixture-operations.json');
        const decisions = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, 'utf8')) : [];
        for (const a of job.approvals) if (!reviewed.has(a.id) && decisions.some(d => d.id === a.id && d.sha256 === a.sha256)) {
          await page.getByRole('button', { name: '审阅此次操作', exact: true }).first().click();
          reviewed.add(a.id); approvalCount++;
        }
      }
      await page.waitForTimeout(300);
    }
    assert.equal(job.state, 'succeeded', job?.error_code);
    assert.ok(approvalCount > 0);
    assert.equal(job.deployment.adapter_version, '0.3.1');
    assert.equal(job.result.artifacts.find(f => f.name === 'report.md').text, 'cross-device-marker-20261007\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8'), 'cross-device-marker-20261007\n');
    assert.deepEqual(await request(`runs/${runId}/files/`), []);
    await page.getByRole('checkbox', { name: 'report.md', exact: true }).check();
    await page.getByRole('button', { name: '同步所选成果到云端', exact: true }).click();
    await page.getByText('report.md（已同步）', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'desktop-result.png'), animations: 'disabled', fullPage: true });
    fs.writeFileSync(path.join(output, 'desktop-receipt.json'), JSON.stringify({ passed: true, run_id: runId, task_id: job.coordination.task_id, workspace_id: published.id, approval_count: approvalCount, deployment: job.deployment, metering: job.metering, original_unchanged: true, no_automatic_upload: true, auth: 'isolated fixture; not real login' }, null, 2));
    console.log('Desktop received Android request, reviewed tools and synced result');
  } finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { fs.writeFileSync(path.join(path.resolve(process.env.WORK_CROSS_DEVICE_OUTPUT), 'desktop-error.txt'), String(e.stack || e)); console.error(e); process.exitCode = 1; });
