// Isolated Electron acceptance: synthetic business auth, real native adapter.
// Native dialogs are selected by the runner; interactive picker UX is not claimed.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

;(async () => {
  if (!process.env.WE_MEET_LOCAL_ADAPTER || !process.env.WE_MEET_LOCAL_KEY_FILE || process.env.WORK_LOCAL_ALLOW_PAID !== '1')
    throw new Error('Explicit adapter/key-file and paid test opt-in required')
  const project = path.resolve(__dirname, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-local-electron-'))
  const profile = path.join(root, 'profile')
  const workspace = path.join(root, '本地 workspace')
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'input.txt'), 'local-electron-marker-8241\n')
  let account = 'fixture-A'
  const cloudRuns = new Map(), metadata = [], uploads = []
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1.0/config/') return res.end(JSON.stringify({ feedback: { url: '' }, background_image: {}, subtitle: { enabled: false }, telephony: { enabled: false }, livekit: { url: '', default_sources: [] }, is_silent_login_enabled: false }))
    if (/^\/api\/v1.0\/users\/me\/?$/.test(req.url) && req.headers.authorization)
      return res.end(JSON.stringify({ id: account, email: 'fixture@example.invalid', full_name: account, last_name: '', language: 'zh-CN', timezone: 'Asia/Shanghai' }))
    if (req.headers.authorization && req.url === '/api/v1.0/work/capabilities/')
      return res.end(JSON.stringify({ enabled: true, local_agent_enabled: true, coordination_contract: 'work-device/v1', materials_enabled: true }))
    if (req.headers.authorization && req.url.startsWith('/api/v1.0/work/materials/'))
      return res.end(JSON.stringify({ results: [], count: 0, next: null, previous: null }))
    if (req.headers.authorization && req.method === 'POST' && req.url.startsWith('/api/v1.0/work/local/')) {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        const body = JSON.parse(data), contract = 'work-device/v1'
        if (req.url.endsWith('/devices/')) return res.end(JSON.stringify({ contract, device_id: body.device_id }))
        if (req.url.endsWith('/tasks/')) {
          if (!cloudRuns.has(body.run_id)) cloudRuns.set(body.run_id, { ...body, id: body.run_id, taskId: crypto.randomUUID(), status: 'queued', seq: 0, uploaded: [] })
          const run = cloudRuns.get(body.run_id)
          return res.end(JSON.stringify({ contract, task: { id: run.taskId }, run: { id: run.id, status: run.status, execution_target: 'local' } }))
        }
        const id = req.url.split('/runs/')[1]?.split('/')[0], run = cloudRuns.get(id)
        if (!run) { res.writeHead(404); return res.end(JSON.stringify({ code: 'not_found' })) }
        if (req.url.endsWith('/claim/')) return res.end(JSON.stringify({ contract, run_id: id, ticket: 'a'.repeat(64), goal: run.goal, model: run.model, report_seq: run.seq, files: [], limits: { max_model_calls: 6, max_total_tokens: 80000, max_output_tokens: 4096 } }))
        if (req.url.endsWith('/report/')) { metadata.push(body); run.seq = body.seq; run.status = body.state === 'cancelled' ? 'canceled' : body.state }
        if (req.url.endsWith('/sync/')) { uploads.push(body); run.uploaded = body.files.map(file => file.name) }
        res.end(JSON.stringify({ contract, run_id: id, report_seq: run.seq, status: run.status, cancel: false, uploaded_files: run.uploaded }))
      })
      return
    }
    res.writeHead(401); res.end(JSON.stringify({ detail: 'Synthetic test service' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: origin }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const launch = async () => {
    console.log('Launching isolated Electron test')
    app = await _electron.launch({ executablePath: require('electron'), args: [project], env, timeout: 30000 })
    app.process().stderr.on('data', chunk => process.stderr.write(chunk))
    const page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = (title, content) => console.error('Electron test error:', title, content)
      process.on('uncaughtException', error => console.error('Electron test exception:', error.stack))
    })
    return page
  }
  const stop = async () => {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
      await app.close().catch(() => {})
      app = undefined
    }
  }
  const seed = async subject => app.evaluate(({ app, safeStorage }, fixture) => {
    if (app.getPath('userData') !== fixture.profile) throw new Error('Unexpected test profile')
    const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path')
    fs.writeFileSync(path.join(fixture.profile, 'session-v1.enc'), safeStorage.encryptString(JSON.stringify({
      issuer: fixture.origin, serviceOrigin: fixture.origin, clientId: 'desktop',
      tokens: { access: 'synthetic-local-smoke-access', refresh: 'synthetic-local-smoke-refresh', subject: fixture.subject, expiresAt: Date.now() + 3600000 },
    })))
  }, { profile, origin, subject })
  try {
    let page = await launch()
    await page.waitForFunction(() => !!window.weMeetDesktop)
    await seed(account); console.log('Seeded synthetic account'); await stop()
    page = await launch()
    await page.goto(origin + '/work?view=new')
    await page.getByRole('heading', { name: '本地工作空间', exact: true }).waitFor()
    assert.equal((await page.evaluate(() => window.weMeetDesktop.localWork.status())).configured, false)
    await app.evaluate(({ dialog }, fixture) => {
      let next = 0
      dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? fixture.workspace : options.title.includes('DEEPSEEK_API_KEY') ? fixture.keyFile : fixture.executable] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, { workspace, executable: process.env.WE_MEET_LOCAL_ADAPTER, keyFile: process.env.WE_MEET_LOCAL_KEY_FILE })
    await page.getByRole('button', { name: '配置本机 dsh', exact: true }).click()
    await page.getByText(/已连接 dsh/).waitFor({ state: 'attached', timeout: 20000 })
    await page.getByRole('button', { name: '选择本地文件夹', exact: true }).click()
    await page.getByText(/当前工作空间/).waitFor()
    await page.getByLabel('工作目标', { exact: true }).fill('Read input.txt in the current local workspace. Write report.md containing its exact contents. Do not change input.txt.')
    await page.getByRole('button', { name: '开始本地处理', exact: true }).click()
    const approvalDir = process.env.WORK_LOCAL_ELECTRON_RECEIPT_DIR || path.join(project, 'test-results', 'local-work')
    fs.mkdirSync(approvalDir, { recursive: true })
    const reviewDeadline = Date.now() + 600000
    let approvalCount = 0
    while (Date.now() < reviewDeadline) {
      const id = new URL(page.url()).searchParams.get('localRun')
      const pendingJob = id ? await page.evaluate(id => window.weMeetDesktop.localWork.get(id), id) : null
      if (pendingJob && !['queued', 'running'].includes(pendingJob.state)) break
      if (pendingJob?.approvals?.length) {
        fs.writeFileSync(path.join(approvalDir, 'pending-approval.json'), JSON.stringify({ run_id: id, workspace, approvals: pendingJob.approvals }, null, 2))
        const decisionFile = path.join(approvalDir, 'approved-fixture-operations.json')
        const decisions = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, 'utf8')) : []
        const allowed = pendingJob.approvals.find(a => decisions.some(d => d.id === a.id && d.sha256 === a.sha256))
        if (allowed) {
          await page.getByRole('button', { name: '审阅此次操作', exact: true }).first().click()
          approvalCount++
          console.log('Reviewed fixture operation', approvalCount)
        }
      }
      await page.waitForTimeout(300)
    }
    await page.getByRole('status').filter({ hasText: '成果已完成' }).waitFor({ timeout: 200000 })
    const runId = new URL(page.url()).searchParams.get('localRun')
    const job = await page.evaluate(id => window.weMeetDesktop.localWork.get(id), runId)
    assert.equal(job.state, 'succeeded', job.error_code)
    assert.equal(job.metering.complete, true)
    assert.match(job.result.artifacts.find(a => a.name === 'report.md').text, /local-electron-marker-8241/)
    assert.equal(fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8'), 'local-electron-marker-8241\n')
    assert.equal(job.coordination.task_id, cloudRuns.get(runId).taskId)
    assert.equal(uploads.length, 0)
    assert.equal(JSON.stringify(metadata).includes('local-electron-marker-8241'), false)
    assert.equal(JSON.stringify(metadata).includes(fs.realpathSync(workspace)), false)
    assert.equal(JSON.stringify(job).includes('a'.repeat(64)), false)
    await page.getByRole('checkbox', { name: 'report.md', exact: true }).check()
    await page.getByRole('button', { name: '同步所选成果到云端', exact: true }).click()
    await page.getByText('report.md（已同步）', { exact: true }).waitFor()
    assert.deepEqual(uploads[0].files.map(file => file.name), ['report.md'])
    assert.match(uploads[0].files[0].text, /local-electron-marker-8241/)
    const opened = await app.evaluate(({ shell }) => { shell.openPath = async value => { globalThis.localOpened = value; return '' }; return true })
    assert.equal(opened, true)
    await page.getByRole('button', { name: '在本机打开成果文件', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(await app.evaluate(() => globalThis.localOpened), path.join(fs.realpathSync(workspace), 'WeMeet成果', runId, 'output', 'report.md'))
    // Cancellation before admission must stay cancelled when the same UUID arrives.
    const cancelId = crypto.randomUUID()
    const cancellation = await page.evaluate(async ({ id, workspaceId }) => {
      const bridge = window.weMeetDesktop.localWork
      await bridge.cancel(id)
      return bridge.submit({ run_id: id, workspace_id: workspaceId, goal: 'Must not execute cancelled admission' })
    }, { id: cancelId, workspaceId: job.workspace_id })
    assert.equal(cancellation.state, 'cancelled')
    const arityRejected = await page.evaluate(async ({ runId, workspaceId }) => {
      try { await window.weMeetDesktop.localWork.submit({ run_id: runId, workspace_id: workspaceId, goal: 'bad raw path', workspace: 'C:\\' }); return false }
      catch (error) { return error.message.includes('invalid_local_request') }
    }, { runId: crypto.randomUUID(), workspaceId: job.workspace_id })
    assert.equal(arityRejected, true)
    // Cancel an admitted native runner while it is starting, then close it via logout.
    const activeCancelId = crypto.randomUUID()
    await page.evaluate(({ id, workspaceId }) => window.weMeetDesktop.localWork.submit({ run_id: id, workspace_id: workspaceId, goal: 'Read input.txt and produce report.md. Preserve the original.' }), { id: activeCancelId, workspaceId: job.workspace_id })
    await page.waitForFunction(async id => (await window.weMeetDesktop.localWork.get(id)).state === 'running', activeCancelId)
    await page.waitForTimeout(500)
    assert.equal((await page.evaluate(id => window.weMeetDesktop.localWork.cancel(id), activeCancelId)).state, 'cancelled')
    const output = process.env.WORK_LOCAL_ELECTRON_RECEIPT_DIR || path.join(project, 'test-results', 'local-work')
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'local-work-completed.png'), fullPage: true, animations: 'disabled' })
    await page.evaluate(() => { void window.weMeetDesktop.logout() })
    await page.waitForFunction(async () => (await window.weMeetDesktop.getStatus()).auth === 'signed-out')
    assert.equal(await page.evaluate(async () => { try { await window.weMeetDesktop.localWork.list(); return false } catch { return true } }), true)
    account = 'fixture-B'; await seed(account); await stop()
    page = await launch()
    await page.goto(origin + '/work?view=new')
    await page.getByRole('heading', { name: '本地工作空间', exact: true }).waitFor()
    assert.equal((await page.evaluate(() => window.weMeetDesktop.localWork.status())).configured, false)
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ passed: true, tested_at: new Date().toISOString(), version: require('../package.json').version, checks: ['real-renderer-coordination', 'manual-selected-sync', 'metadata-excludes-private-body', 'ticket-not-in-renderer', 'real-renderer-native-config', 'native-folder-grant', 'real-dsh-file-read', 'local-deliverable', 'metered-DeepSeek', 'native-open-confined-file', 'cancel-before-admission', 'cancel-running-native-task', 'raw-path-request-rejected', 'logout-rejects-local-access', 'account-B-has-no-account-A-configuration'], job, limitation: 'Development Electron with bundled renderer, synthetic business account/API and mocked native dialog selections. Actual dsh and DeepSeek. Not installer/interactive picker acceptance.' }, null, 2))
    console.log('Local Electron acceptance passed; test-results/local-work')
  } finally { await stop(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
