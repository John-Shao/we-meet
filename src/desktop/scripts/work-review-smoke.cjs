// Real bundled renderer -> preload -> IPC -> WorkCoordinator acceptance.
// Auth/API, native execution and dialog choices are synthetic; no supplier calls.
const { _electron, expect } = require('../../frontend/node_modules/@playwright/test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

;(async () => {
  const project = path.resolve(__dirname, '..')
  const output = path.join(project, 'test-results', 'work-review')
  fs.mkdirSync(output, { recursive: true })
  const receiptPath = path.join(output, 'receipt.json')
  fs.rmSync(receiptPath, { force: true })
  assert.ok(fs.existsSync(path.join(project, 'dist', 'renderer', 'index.html')), 'Build and copy the renderer first')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-review-electron-'))
  const profile = path.join(root, 'profile')
  const workspace = path.join(root, '本地 workspace')
  fs.mkdirSync(workspace)
  const account = 'fixture-review-A'
  const access = 'synthetic-review-smoke-access'
  const reportText = 'review-electron-marker-8241: delivery pending acceptance\n'
  const privateText = 'private-local-only-8241\n'
  const quote = '<script>globalThis.reviewEvidenceExecuted = true</script>'
  const cloudRuns = new Map(), metadata = [], uploads = [], reviewRequests = [], reviewRecords = new Map()
  const apiErrors = [], checks = []
  let revoke = false, loseFirstReviewAck = true
  const respond = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.invalid'), pathname = url.pathname
      if (pathname === '/api/v1.0/config/') return respond(res, { feedback: { url: '' }, background_image: {}, subtitle: { enabled: false }, telephony: { enabled: false }, livekit: { url: '', default_sources: [] }, is_silent_login_enabled: false })
      if (req.headers.authorization !== `Bearer ${access}`) return respond(res, { detail: 'Synthetic test service' }, 401)
      if (/^\/api\/v1.0\/users\/me\/?$/.test(pathname)) return respond(res, { id: account, email: 'fixture@example.invalid', full_name: account, last_name: '', language: 'zh-CN', timezone: 'Asia/Shanghai' })
      if (pathname === '/api/v1.0/work/capabilities/') return respond(res, { enabled: true, local_agent_enabled: true, coordination_contract: 'work-device/v1', materials_enabled: true, review_enabled: true, review_token_budget: 20000 })
      if (pathname === '/api/v1.0/work/materials/') return respond(res, { results: [], count: 0, next: null, previous: null })
      let body
      if (req.method === 'POST') {
        let data = ''
        for await (const chunk of req) data += chunk
        body = data ? JSON.parse(data) : {}
      }
      if (req.method === 'POST' && pathname.startsWith('/api/v1.0/work/local/')) {
        const contract = 'work-device/v1'
        if (pathname.endsWith('/devices/')) return respond(res, { contract, device_id: body.device_id })
        if (pathname.endsWith('/tasks/')) {
          assert.equal(JSON.stringify(body).includes(fs.realpathSync(workspace)), false)
          if (!cloudRuns.has(body.run_id)) cloudRuns.set(body.run_id, { ...body, id: body.run_id, taskId: crypto.randomUUID(), status: 'queued', seq: 0, uploaded: [] })
          const run = cloudRuns.get(body.run_id)
          return respond(res, { contract, task: { id: run.taskId }, run: { id: run.id, status: run.status, execution_target: 'local' } })
        }
        const id = pathname.split('/runs/')[1]?.split('/')[0], run = cloudRuns.get(id)
        assert.ok(run, 'Known admitted local run')
        if (pathname.endsWith('/claim/')) return respond(res, { contract, run_id: id, ticket: 'a'.repeat(64), goal: run.goal, model: run.model, report_seq: run.seq, files: [], limits: { max_model_calls: 6, max_total_tokens: 80000, max_output_tokens: 4096 } })
        if (pathname.endsWith('/report/')) { metadata.push(body); run.seq = body.seq; run.status = body.state }
        if (pathname.endsWith('/sync/')) { uploads.push(body); run.uploaded = body.files.map(file => file.name) }
        return respond(res, { contract, run_id: id, report_seq: run.seq, status: run.status, cancel: false, uploaded_files: run.uploaded })
      }
      const match = pathname.match(/^\/api\/v1\.0\/work\/runs\/([^/]+)\/(files|reviews)(?:\/([^/]+)\/cancel)?\/$/)
      if (match) {
        const [, runId, resource, reviewId] = match, run = cloudRuns.get(runId)
        assert.ok(run)
        if (revoke) return respond(res, { code: 'source_unavailable' }, 409)
        if (resource === 'files') return respond(res, uploads.flatMap(upload => upload.files).filter(file => run.uploaded.includes(file.name)).map(({ name, sha256 }) => ({ name, sha256 })))
        if (reviewId) {
          const review = [...reviewRecords.values()].find(review => review.id === reviewId)
          assert.ok(review)
          assert.equal(review.source_run_id, runId)
          review.status = 'canceled'
          return respond(res, review)
        }
        if (req.method === 'GET') return respond(res, [...reviewRecords.values()].filter(review => review.source_run_id === runId))
        assert.equal(req.method, 'POST')
        const key = req.headers['idempotency-key']
        assert.match(key, /^[a-f0-9-]{36}$/)
        assert.deepEqual(body.files, [{ name: 'report.md', sha256: crypto.createHash('sha256').update(reportText).digest('hex') }])
        reviewRequests.push({ key, files: body.files })
        if (!reviewRecords.has(key)) reviewRecords.set(key, { id: crypto.randomUUID(), source_run_id: runId, status: 'queued', error_code: '', model: 'qwen3.8-flash', selection: body.files, snapshot: body.files, reserved_tokens: 20000, input_tokens: null, output_tokens: null, report: {} })
        if (loseFirstReviewAck) { loseFirstReviewAck = false; req.socket.destroy(); return }
        return respond(res, reviewRecords.get(key), 201)
      }
      return respond(res, { detail: 'Unsupported synthetic endpoint' }, 404)
    } catch (error) { apiErrors.push(error.message); respond(res, { code: 'fixture_error' }, 500) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: origin }
  delete env.ELECTRON_RUN_AS_NODE
  let app, page
  const stop = async () => {
    if (!app) return
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
    await app.close().catch(() => {})
    app = undefined
  }
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [project], env, timeout: 30000 })
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    // Block unrelated services; only the isolated fixture can receive requests.
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === origin || !['http:', 'https:'].includes(url.protocol) ? route.continue() : route.abort()
    })
    await app.evaluate(({ dialog }) => { dialog.showErrorBox = (title, content) => console.error('Electron fixture error:', title, content) })
    await page.waitForFunction(() => !!window.weMeetDesktop)
  }
  try {
    console.log('Seeding isolated encrypted synthetic session and native configuration')
    await launch()
    await app.evaluate(({ app, safeStorage }, fixture) => {
      if (app.getPath('userData') !== fixture.profile) throw new Error('Unexpected test profile')
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path'), crypto = process.getBuiltinModule('crypto')
      fs.writeFileSync(path.join(fixture.profile, 'session-v1.enc'), safeStorage.encryptString(JSON.stringify({ issuer: fixture.origin, serviceOrigin: fixture.origin, clientId: 'desktop', tokens: { access: fixture.access, refresh: 'synthetic-review-smoke-refresh', subject: fixture.account, expiresAt: Date.now() + 3600000 } })))
      const owner = crypto.createHash('sha256').update(fixture.origin + '\n' + fixture.account).digest('hex')
      const directory = path.join(fixture.profile, 'local-work-v1', owner)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'configuration.enc'), safeStorage.encryptString(JSON.stringify({ executable: path.join(fixture.profile, 'synthetic-work-agent-local.exe'), apiKey: 'synthetic-native-key', model: 'deepseek-flash' })))
    }, { profile, origin, account, access })
    await stop()
    await launch()
    console.log('Running bundled Work UI with synthetic native transport')
    // Patch only the native transport boundary in this test process. Production
    // renderer, preload, IPC authorization and cloud coordinator stay unchanged.
    await app.evaluate(({ dialog }, fixture) => {
      const path = process.getBuiltinModule('path'), crypto = process.getBuiltinModule('crypto')
      const req = process.getBuiltinModule('module').createRequire(path.join(fixture.project, 'dist', 'main.js'))
      const { LocalWorkClient } = req('./local-work.js')
      const jobs = new Map(), grant = { id: crypto.randomUUID(), path: process.getBuiltinModule('fs').realpathSync(fixture.workspace), name: path.basename(fixture.workspace) }
      globalThis.nativeReviewCalls = []
      LocalWorkClient.prototype.request = async function (method, body = {}) {
        globalThis.nativeReviewCalls.push({ method, body })
        if (method === 'capabilities') return { ready: true, contract: 'work-local/v1', engine: 'dsh', model: 'deepseek-flash', runtime_version: 'synthetic', adapter_version: 'synthetic', execution: 'local', features: ['cloud_context', 'run_limits', 'command_approval'] }
        if (method === 'grant') { if (body.path !== grant.path) throw new Error('workspace_permission_required'); return grant }
        if (method === 'list') return [...jobs.values()]
        if (method === 'submit' && !jobs.has(body.run_id)) {
          if (body.workspace_id !== grant.id) throw new Error('workspace_permission_required')
          jobs.set(body.run_id, { ...body, workspace: grant.path, state: 'succeeded', error_code: '', metering: { calls: 0, complete: true, usage: null }, result: { summary: 'Synthetic native deliverables', artifacts: [{ name: 'report.md', text: fixture.reportText }, { name: 'private.csv', text: fixture.privateText }].map(file => ({ ...file, sha256: crypto.createHash('sha256').update(file.text).digest('hex') })) } })
        }
        if (method === 'get' || method === 'submit') { if (!jobs.has(body.run_id)) throw new Error('not_found'); return jobs.get(body.run_id) }
        throw new Error('unsupported_fixture_operation')
      }
      dialog.showOpenDialog = async (_window, options) => {
        if (!options.properties.includes('openDirectory')) throw new Error('Unexpected file picker')
        return { canceled: false, filePaths: [fixture.workspace] }
      }
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, { project, workspace, reportText, privateText })
    await page.goto(origin + '/work?view=new')
    await page.getByRole('heading', { name: '本地工作空间', exact: true }).waitFor()
    await page.getByText(/已连接 dsh/).waitFor()
    const security = await app.evaluate(({ BrowserWindow }) => {
      const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration }
    })
    assert.deepEqual(security, { contextIsolation: true, nodeIntegration: false })
    await page.getByRole('button', { name: '选择本地文件夹', exact: true }).click()
    await page.getByText(/当前工作空间/).waitFor()
    await expect(page.getByLabel('登记到云端任务记录')).toBeChecked()
    await page.getByLabel('工作目标', { exact: true }).fill('Check synthetic delivery status and generate report.md; preserve private.csv locally.')
    await page.getByRole('button', { name: '开始本地处理', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '成果已完成' }).waitFor()
    const runId = new URL(page.url()).searchParams.get('localRun')
    assert.ok(runId)
    assert.equal(uploads.length, 0)
    assert.equal(reviewRecords.size, 0)
    assert.equal(await page.getByRole('region', { name: '成果复核', exact: true }).count(), 0)
    assert.equal(JSON.stringify(metadata).includes(reportText.trim()), false)
    assert.equal(JSON.stringify(metadata).includes(privateText.trim()), false)
    assert.equal(JSON.stringify(metadata).includes(fs.realpathSync(workspace)), false)
    const job = await page.evaluate(id => window.weMeetDesktop.localWork.get(id), runId)
    assert.equal(JSON.stringify(job).includes('a'.repeat(64)), false)
    checks.push('isolated-window-and-real-preload-ipc', 'native-folder-grant-through-ipc', 'metadata-excludes-private-body-and-absolute-path', 'claim-ticket-hidden', 'no-automatic-file-sync-or-review')

    await page.getByRole('checkbox', { name: 'report.md', exact: true }).check()
    await page.getByRole('button', { name: '同步所选成果到云端', exact: true }).click()
    const reviewUI = page.getByRole('region', { name: '成果复核', exact: true })
    await reviewUI.waitFor()
    assert.deepEqual(uploads[0].files.map(file => file.name), ['report.md'])
    assert.equal(JSON.stringify(uploads).includes(privateText.trim()), false)
    await expect(reviewUI.getByLabel('private.csv', { exact: true })).toHaveCount(0)
    const start = reviewUI.getByRole('button', { name: '开启本次复核', exact: true })
    await expect(start).toBeDisabled()
    await reviewUI.getByLabel('report.md', { exact: true }).check()
    await expect(start).toBeDisabled()
    await reviewUI.getByLabel('同意将选定成果和本任务已授权材料发送至复核模型').check()
    await expect(start).toBeEnabled()
    checks.push('manual-selected-file-sync', 'review-lists-only-synced-identities', 'separate-review-sending-consent')
    console.log('Selected sync and separate review consent passed')

    await start.click()
    await reviewUI.getByRole('alert').waitFor()
    assert.equal(reviewRequests.length, 1, 'No automatic create retry')
    await start.click()
    await reviewUI.getByRole('heading', { name: '等待复核', exact: true }).waitFor()
    assert.equal(reviewRequests.length, 2)
    assert.equal(reviewRequests[0].key, reviewRequests[1].key)
    assert.equal(reviewRecords.size, 1)
    checks.push('lost-create-ack-reuses-idempotency-key', 'one-synthetic-review-after-manual-retry')
    const first = [...reviewRecords.values()][0]
    first.status = 'succeeded'; first.input_tokens = 123; first.output_tokens = 45
    first.report = { verdict: 'needs_changes', summary: 'Synthetic delivery requires acceptance confirmation.', findings: [{ severity: 'warning', message: 'Verify acceptance status.', evidence: [{ file: 'result-01.md', sha256: first.selection[0].sha256, quote }] }], missing_information: ['Acceptance owner not provided.'] }
    await reviewUI.getByRole('heading', { name: '复核完成', exact: true }).waitFor({ timeout: 12000 })
    await expect(reviewUI.getByText(quote, { exact: true })).toBeVisible()
    await expect(reviewUI.getByText('实际输入 123 / 输出 45 tokens', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => globalThis.reviewEvidenceExecuted), undefined)
    assert.equal((await reviewUI.textContent()).includes('qwen3.8-flash'), true)
    await reviewUI.screenshot({ path: path.join(output, 'review-completed.png'), animations: 'disabled' })
    checks.push('polling-status-model-and-metering', 'review-evidence-rendered-as-text')
    console.log('Lost response recovery and completed review display passed')

    await expect(start).toBeEnabled()
    await start.click()
    await reviewUI.getByRole('button', { name: '取消复核', exact: true }).click()
    await reviewUI.getByRole('heading', { name: '已取消复核', exact: true }).waitFor()
    assert.equal(reviewRecords.size, 2)
    assert.equal((await page.evaluate(id => window.weMeetDesktop.localWork.get(id), runId)).state, 'succeeded')
    const nativeCalls = await app.evaluate(() => globalThis.nativeReviewCalls)
    assert.equal(nativeCalls.filter(call => call.method === 'submit').length, 1)
    assert.equal(nativeCalls.some(call => call.method === 'cancel'), false)
    checks.push('cancel-review-preserves-original-local-job')

    // Trigger a real failed background permission recheck without unmounting:
    // React Query still holds cached success data at this point.
    await start.click()
    await reviewUI.getByRole('heading', { name: '等待复核', exact: true }).waitFor()
    revoke = true
    await reviewUI.getByRole('alert').waitFor()
    await expect(reviewUI.getByText(quote, { exact: true })).toHaveCount(0)
    await expect(reviewUI.getByLabel('report.md', { exact: true })).toHaveCount(0)
    await expect(start).toBeDisabled()
    revoke = false
    await reviewUI.getByRole('button', { name: '重新加载', exact: true }).click()
    await expect(reviewUI.getByText(quote, { exact: true })).toBeVisible()
    await expect(reviewUI.getByLabel('report.md', { exact: true })).not.toBeChecked()
    await expect(reviewUI.getByLabel('同意将选定成果和本任务已授权材料发送至复核模型')).not.toBeChecked()
    await reviewUI.getByRole('button', { name: '取消复核', exact: true }).click()
    await expect(reviewUI.getByRole('heading', { name: '已取消复核', exact: true })).toHaveCount(2)
    await expect(start).toBeDisabled()
    const finalNativeCalls = await app.evaluate(() => globalThis.nativeReviewCalls)
    assert.equal(finalNativeCalls.filter(call => call.method === 'submit').length, 1)
    assert.equal(finalNativeCalls.some(call => call.method === 'cancel'), false)
    checks.push('permission-recheck-hides-cached-report-and-identities', 'restored-access-requires-new-selection-and-consent')
    await page.evaluate(() => { void window.weMeetDesktop.logout() })
    // Logout deliberately visits about:blank while clearing the old session;
    // native IPC correctly rejects that transient untrusted document.
    await page.waitForFunction(async () => {
      try { return (await window.weMeetDesktop.getStatus()).auth === 'signed-out' }
      catch { return false }
    })
    assert.equal(await page.evaluate(async () => { try { await window.weMeetDesktop.localWork.list(); return false } catch { return true } }), true)
    checks.push('logout-rejects-local-access')
    assert.deepEqual(apiErrors, [])
    fs.writeFileSync(receiptPath, JSON.stringify({ passed: true, tested_at: new Date().toISOString(), version: require('../package.json').version, checks, review_create_attempts: reviewRequests.length, synthetic_review_count: reviewRecords.size, native_submissions: 1, supplier_calls: 0, security, limitation: 'Development Electron with bundled renderer and real preload/IPC/coordinator. Synthetic auth/API/native transport and automated native dialog choices. Does not certify OIDC login, real dsh/Pi/supplier, installer, interactive picker, signing or deployment.' }, null, 2) + '\n')
    console.log(`Work review Electron acceptance passed (${checks.length} checks, zero supplier calls)`)
  } finally {
    await stop()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('meet-review-electron-')) throw new Error('Unexpected cleanup target')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
