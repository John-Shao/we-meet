// Explicit production account cohort opt-in: one task and manually reviewed tools.
// Real HTTPS OTP session bootstrap; native login and native dialog UX are excluded.
const { _electron } = require('../../frontend/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const origin = process.env.WORK_COORDINATION_URL;
  if (origin !== 'https://meet.we-meet.online' || process.env.WORK_ACCOUNT_COHORT !== '1' || !process.env.WE_MEET_LOCAL_KEY_FILE || process.env.WORK_LOCAL_ALLOW_PAID !== '1') throw Error('Reviewed production cohort and explicit model opt-in required');
  const output = path.resolve(process.env.WORK_CROSS_DEVICE_OUTPUT);
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cross-device-'));
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, '本地 工作空间');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'input.txt'), 'cross-device-marker-20261007\n');
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: 'https://id.we-meet.online/realms/meet' };
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
    checkpoint('authenticated-session-bootstrap');
    const sessionResponse = await fetch('http://127.0.0.1:48762/desktop', { redirect: 'error' });
    assert.equal(sessionResponse.status, 200);
    let realSession = await sessionResponse.json();
    await app.evaluate(({ app, safeStorage }, fixture) => {
      if (app.getPath('userData') !== fixture.profile) throw Error('Wrong profile');
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
      fs.writeFileSync(path.join(fixture.profile, 'session-v1.enc'), safeStorage.encryptString(JSON.stringify({
        issuer: 'https://id.we-meet.online/realms/meet', serviceOrigin: fixture.origin, clientId: 'desktop',
        tokens: fixture.realSession,
      })));
    }, { profile, origin, realSession });
    realSession = undefined;
    checkpoint('stopping-initial');
    await stop(); page = await launch(); page.setDefaultTimeout(20000);
    checkpoint('configuring');
    page.on('pageerror', e => fs.writeFileSync(path.join(output, 'renderer-error.txt'), String(e.name || 'client_failure')));
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? fixture.workspace : fixture.keyFile] });
      dialog.showMessageBox = async (_win, options) => {
        const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
        let allow = options.title === '授权本地 dsh' && options.message === fixture.workspace;
        if (options.title === '领取远程工作') allow = options.message === 'Read input.txt in the current local workspace. Write report.md containing its exact contents. Do not modify input.txt.' && options.detail.includes(fixture.workspace);
        if (options.title === '审阅本机操作') {
          const pending = JSON.parse(fs.readFileSync(path.join(fixture.output, 'pending-approval.json'), 'utf8'));
          const decisions = JSON.parse(fs.readFileSync(path.join(fixture.output, 'approved-fixture-operations.json'), 'utf8'));
          allow = pending.workspace === fixture.workspace && pending.approvals.some(a => options.detail.includes(a.arguments) && decisions.some(d => d.id === a.id && d.sha256 === a.sha256));
        }
        return { response: allow ? 1 : 0, checkboxChecked: false };
      };
    }, { workspace, output, keyFile: process.env.WE_MEET_LOCAL_KEY_FILE });
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
    const ownDeviceId = await app.evaluate(({ app, safeStorage }) => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
      const directory = path.join(app.getPath('userData'), 'local-work-v1');
      const owners = fs.readdirSync(directory);
      if (owners.length !== 1) throw Error('Unexpected private fixture account count');
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(directory, owners[0], 'coordination.enc')))).deviceId;
    });
    // Change only the display label through the real business endpoint; no native paths sent.
    const request = async (endpoint, body) => {
      const value = await page.evaluate(async ({ endpoint, body }) => {
        const response = await fetch('/api/v1.0/work/' + endpoint, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
        return { status: response.status, body: await response.json() };
      }, { endpoint, body });
      assert.ok(value.status >= 200 && value.status < 300, endpoint); return value.body;
    };
    let published;
    for (let n = 0; n < 100; n++) {
      const listing = await request('local/workspaces/'); published = listing.workspaces.find(w => w.enabled && w.device_id === ownDeviceId);
      if (published) break; await page.waitForTimeout(100);
    }
    assert.ok(published);
    await request('local/workspaces/', { device_id: published.device_id, workspace_id: published.id, label: 'Cohort workspace', model: published.model, enabled: true });
    fs.writeFileSync(path.join(output, 'desktop-ready.json'), JSON.stringify({ workspace_id: published.id }));
    const take = page.getByRole('button', { name: '审阅并领取', exact: true }).first();
    await take.waitFor({ timeout: 90000 });
    assert.deepEqual(await page.evaluate(() => window.weMeetDesktop.localWork.list()), []);
    await take.click();
    let job, runId, approvalCount = 0;
    const reviewed = new Set();
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(output, 'abort-client'))) {
        if (runId) await page.evaluate(id => window.weMeetDesktop.localWork.cancel(id), runId).catch(() => {});
        throw Error('cohort_client_aborted');
      }
      runId = new URL(page.url()).searchParams.get('localRun');
      job = runId ? await page.evaluate(id => window.weMeetDesktop.localWork.get(id), runId) : null;
      if (job && !['queued', 'running'].includes(job.state)) break;
      if (job?.approvals?.length) {
        fs.writeFileSync(path.join(output, 'pending-approval.json'), JSON.stringify({ run_id: runId, workspace, approvals: job.approvals }, null, 2));
        const decisionFile = path.join(output, 'approved-fixture-operations.json');
        const decisions = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, 'utf8')) : [];
        for (const a of job.approvals) if (!reviewed.has(a.id) && decisions.some(d => d.id === a.id && d.sha256 === a.sha256)) {
          await page.locator('div').filter({ has: page.locator('pre.work-text', { hasText: a.arguments }) }).filter({ has: page.getByRole('button', { name: '审阅此次操作', exact: true }) }).last().getByRole('button', { name: '审阅此次操作', exact: true }).click();
          reviewed.add(a.id); approvalCount++;
        }
      }
      await page.waitForTimeout(300);
    }
    fs.writeFileSync(path.join(output, 'desktop-terminal.json'), JSON.stringify({
      state: job?.state, error_code: job?.error_code, deployment: job?.deployment,
      metering: job?.metering, approval_count: approvalCount,
      original_unchanged: fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8') === 'cross-device-marker-20261007\n',
      artifacts: (job?.result?.artifacts || []).map(({name, sha256}) => ({name, sha256})),
    }, null, 2));
    assert.equal(job.state, 'succeeded', job?.error_code);
    assert.ok(job.metering.calls <= 5);
    assert.equal(job.metering.complete, true);
    assert.ok(Object.values(job.metering.usage || {}).reduce((a,b) => a+b, 0) <= 20000);
    assert.ok(approvalCount > 0);
    assert.equal(job.deployment.adapter_version, '0.3.2');
    assert.equal(job.result.artifacts.find(f => f.name === 'report.md').text, 'cross-device-marker-20261007\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8'), 'cross-device-marker-20261007\n');
    assert.deepEqual(await request(`runs/${runId}/files/`), []);
    await page.getByRole('checkbox', { name: 'report.md', exact: true }).check();
    await page.getByRole('button', { name: '同步所选成果到云端', exact: true }).click();
    await page.getByText('report.md（已同步）', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'desktop-result.png'), animations: 'disabled', fullPage: true });
    fs.writeFileSync(path.join(output, 'desktop-receipt.json'), JSON.stringify({ passed: true, run_id: runId, task_id: job.coordination.task_id, workspace_id: published.id, device_id: published.device_id, approval_count: approvalCount, deployment: job.deployment, metering: job.metering, original_unchanged: true, no_automatic_upload: true, auth: 'real HTTPS demo OTP session; native login UX excluded' }, null, 2));
    console.log('Desktop received Android request, reviewed tools and synced result');
    let reviewStarted = false;
    while (!fs.existsSync(path.join(output, 'close-client')) && !fs.existsSync(path.join(output, 'abort-client'))) {
      const reviewSignal = path.join(output, 'start-pi-review.json');
      if (!reviewStarted && fs.existsSync(reviewSignal)) {
        const approved = JSON.parse(fs.readFileSync(reviewSignal, 'utf8'));
        const selected = [{ name: 'report.md', sha256: job.result.artifacts.find(f => f.name === 'report.md').sha256 }];
        assert.equal(approved.source_run_id, runId);
        assert.deepEqual(approved.files, selected);
        assert.equal(approved.model, 'qwen3.8-flash');
        assert.equal(approved.token_budget, 8000);
        assert.equal(approved.max_model_calls, 1);
        const caps = await request('capabilities/');
        assert.equal(caps.review_enabled, true);
        assert.equal(caps.review_model, approved.model);
        assert.equal(caps.review_token_budget, approved.token_budget);
        assert.equal(caps.agent_enabled, false);
        assert.deepEqual(await request(`runs/${runId}/reviews/`), []);
        // Persist the single attempt before clicking. Uncertain outcomes are queried,
        // never converted into a second paid review by this acceptance entry point.
        reviewStarted = true;
        fs.writeFileSync(path.join(output, 'pi-review-started.json'), JSON.stringify(approved));
        await page.reload();
        const reviewUI = page.getByRole('region', { name: '成果复核', exact: true });
        await reviewUI.waitFor();
        await reviewUI.getByLabel('report.md', { exact: true }).check();
        await reviewUI.getByLabel('同意将选定成果和本任务已授权材料发送至复核模型').check();
        await reviewUI.getByRole('button', { name: '开启本次复核', exact: true }).click();
        let review;
        for (const deadline = Date.now() + 300000; Date.now() < deadline;) {
          if (fs.existsSync(path.join(output, 'abort-client'))) throw Error('cohort_client_aborted');
          const reviews = await request(`runs/${runId}/reviews/`);
          assert.ok(reviews.length <= 1);
          review = reviews[0];
          if (review && !['queued', 'running'].includes(review.status)) break;
          await page.waitForTimeout(1500);
        }
        fs.writeFileSync(path.join(output, 'pi-review-terminal.json'), JSON.stringify(review || { error: 'review_not_admitted' }, null, 2));
        assert.equal(review?.status, 'succeeded', review?.error_code);
        assert.equal(review.model, approved.model);
        assert.deepEqual(review.selection, selected);
        assert.ok(['no_issues', 'needs_changes', 'inconclusive'].includes(review.report.verdict));
        assert.ok(Number.isInteger(review.input_tokens) && review.input_tokens >= 0);
        assert.ok(Number.isInteger(review.output_tokens) && review.output_tokens >= 0);
        assert.ok(review.input_tokens + review.output_tokens <= approved.token_budget);
        await reviewUI.getByRole('heading', { name: '复核完成', exact: true }).waitFor();
        await page.screenshot({ path: path.join(output, 'desktop-pi-review.png'), animations: 'disabled', fullPage: true });
        const unchanged = await request(`runs/${runId}/files/`);
        assert.deepEqual(unchanged.map(({name, sha256}) => ({name, sha256})), selected);
        assert.equal(fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8'), 'cross-device-marker-20261007\n');
        fs.writeFileSync(path.join(output, 'pi-review-receipt.json'), JSON.stringify({
          passed: true, source_run_id: runId, review_id: review.id, model: review.model,
          input_tokens: review.input_tokens, output_tokens: review.output_tokens,
          verdict: review.report.verdict, files: selected, separate_consent: true,
          original_and_synced_result_unchanged: true, desktop_review_visible: true,
        }, null, 2));
        console.log('One separately authorized Pi review verified through the real desktop UI');
      }
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => window.weMeetDesktop.logout());
  } finally { await stop(); assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('meet-cross-device-')); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { fs.writeFileSync(path.join(path.resolve(process.env.WORK_CROSS_DEVICE_OUTPUT), 'desktop-error.txt'), String(e.name || 'client_failure')); console.error('Account cohort desktop acceptance failed'); process.exitCode = 1; });
