// Explicitly authorized live office smoke: real installed app, PKCE and model.
// Uses only a demo account and a synthetic material. Never persists credentials.
const { _electron, chromium } = require('../../frontend/node_modules/@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')

const base = 'https://meet.we-meet.online'
const output = path.resolve(__dirname, '../test-results')
const report = { testedAt: new Date().toISOString(), checks: {}, pageErrors: [], cleanup: {},
  limitation: 'Dedicated browser hands the genuine callback to a second app instance; native browser confirmation and file dialogs are not covered.' }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
let app, page, browser, materialId, taskId, runId, authenticated = false
const save = () => fs.writeFile(path.join(output, 'work-installed-acceptance.json'), JSON.stringify(report, null, 2))
async function launch(executablePath) {
  app = await _electron.launch({ executablePath, env, timeout: 45000 })
  await app.evaluate(({ app }, file) => {
    process.on('uncaughtExceptionMonitor', error => {
      process.getBuiltinModule('fs').appendFileSync(file, app.getVersion() + '\n' + String(error.stack || error.message).replace(/https?:\/\/\S+/g, '[URL]') + '\n')
    })
  }, path.join(output, 'work-installed-main-errors.log'))
  page = await app.firstWindow(); page.setDefaultTimeout(45000)
  page.on('pageerror', e => report.pageErrors.push(e.name))
  await page.waitForFunction(async () => (await window.weMeetDesktop?.getStatus())?.connection === 'online')
  // A ready bridge can precede completion of main.ts's initial loadURL promise.
  // Navigating here too soon cancels that startup request (ERR_ABORTED).
  await page.waitForLoadState('load', { timeout: 45000 })
  await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
  return page.evaluate(() => window.weMeetDesktop.getStatus())
}
async function api(suffix, options) {
  return page.evaluate(async ({ suffix, options }) => {
    const response = await fetch('/api/v1.0/work/' + suffix, { ...options, signal: AbortSignal.timeout(15000) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }, { suffix, options })
}
async function quit() {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null }
}
async function login(exe, phone, otp) {
  await app.evaluate(({ shell }) => {
    globalThis.workAcceptanceLoginUrl = ''
    const open = shell.openExternal.bind(shell)
    shell.openExternal = async url => {
      if (new URL(url).origin === 'https://id.we-meet.online') globalThis.workAcceptanceLoginUrl = url
      else await open(url)
    }
  })
  await page.locator('[data-attr="login"]').first().click({ noWaitAfter: true })
  let target
  for (let i = 0; i < 150; i++) {
    target = await app.evaluate(() => globalThis.workAcceptanceLoginUrl)
    if (target) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(target, 'No PKCE handoff')
  const authUrl = new URL(target)
  assert.equal(authUrl.searchParams.get('client_id'), 'desktop')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  browser = await chromium.launch({ channel: 'chrome', headless: false })
  const context = await browser.newContext({ locale: 'zh-CN' })
  let callback
  await context.route('https://id.we-meet.online/**', async route => {
    const response = await route.fetch({ maxRedirects: 0 })
    const location = response.headers().location
    if (location?.startsWith('online.we-meet.desktop://oauth/callback')) {
      callback = location
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Desktop authentication completed. Returning to the test app.' })
    } else await route.fulfill({ response })
  })
  const loginPage = await context.newPage(); loginPage.setDefaultTimeout(45000)
  await loginPage.goto(target, { waitUntil: 'domcontentloaded' })
  await loginPage.locator('input[name=phone]').fill(phone)
  const sent = loginPage.waitForResponse(r => r.url().includes('/keycloak-sms/otp/send/') && r.request().method() === 'POST')
  await loginPage.getByRole('button', { name: '获取验证码', exact: true }).click()
  assert.equal((await sent).status(), 200, 'OTP send failed')
  await loginPage.locator('input[name=otp]').fill(otp)
  await loginPage.getByRole('button', { name: '验证登录', exact: true }).click()
  for (let i = 0; i < 200 && !callback; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert(callback, 'No genuine authorization callback')
  const process = spawn(exe, [callback], { env, windowsHide: true, stdio: 'ignore' })
  assert.equal(await new Promise((resolve, reject) => { process.once('exit', resolve); process.once('error', reject) }), 0)
  callback = undefined
  await page.waitForFunction(async () => (await window.weMeetDesktop.getStatus()).auth === 'signed-in')
  authenticated = true
  await browser.close(); browser = null
  report.checks.realDesktopPkce = true
}
;(async () => {
  const exe = process.env.WEMEET_INSTALLED_EXE
  const phone = process.env.WEMEET_DEMO_PHONE || '', otp = process.env.WEMEET_DEMO_OTP || ''
  assert(exe && /^1380000000[0-9]$/.test(phone) && otp, 'Set installed exe and authorized demo credentials')
  await fs.mkdir(output, { recursive: true })
  try {
    const previous = JSON.parse(await fs.readFile(path.join(output, 'work-installed-acceptance.json'), 'utf8'))
    const stamp = String(previous.testedAt).replace(/[^0-9T]/g, '')
    await fs.copyFile(path.join(output, 'work-installed-acceptance.json'), path.join(output, 'work-installed-acceptance-' + stamp + '.json'))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try {
    const status = await launch(exe)
    assert.equal(status.serviceOrigin, base)
    // Never log out an account left by the user to make room for this test.
    const resume = process.env.WEMEET_RESUME_WORK === '1'
    if (!resume) assert.equal(status.auth, 'signed-out', 'Existing signed-in session; stop before changing user data')
    report.runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() }))
    assert.equal(report.runtime.packaged, true)
    assert.match(report.runtime.appPath, /resources[\\/]app\.asar$/)
    let body
    if (resume) {
      // Resume only the exact task created by the previous run of this harness.
      const previous = JSON.parse(await fs.readFile(path.join(output, 'work-installed-acceptance.json'), 'utf8'))
      assert(previous.checks.realDesktopPkce && previous.taskId && previous.runId && previous.materialId)
      assert.equal(status.auth, 'signed-in', 'No preserved test session to resume')
      const existing = await api('tasks/' + previous.taskId + '/')
      assert.equal(existing.status, 200, 'Previous test task not owned by this session')
      assert(existing.body.runs.some(r => r.id === previous.runId))
      materialId = previous.materialId; taskId = previous.taskId; runId = previous.runId
      authenticated = true
      report.materialId = materialId; report.taskId = taskId; report.runId = runId
      report.checks.realDesktopPkce = true; report.checks.resumedPriorTest = true
      report.run = existing.body.runs.find(r => r.id === runId)
      assert.equal(report.run.status, 'succeeded')
      body = (await api('runs/' + runId + '/artifact/')).body.body
      await page.goto(base + '/work?view=communication&task=' + taskId, { waitUntil: 'domcontentloaded' })
      await page.getByLabel('编辑草稿', { exact: true }).waitFor()
    } else {
    await login(exe, phone, otp); console.log('Real desktop PKCE login passed')
    await page.goto(base + '/work', { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '工作材料', exact: true }).waitFor()
    assert.equal((await api('capabilities/')).body.communication_enabled, true)
    const name = 'desktop-office-' + Date.now() + '.md'
    const uploaded = page.waitForResponse(r => r.url().endsWith('/work/materials/') && r.request().method() === 'POST')
    await page.getByLabel('上传工作材料', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown',
      buffer: Buffer.from('桌面办公验收只检查材料上传、沟通准备和下载。\n预算尚未确认。\n演示日期待双方协商，不能承诺交付。') })
    const uploadResponse = await uploaded
    assert.equal(uploadResponse.status(), 201)
    materialId = (await uploadResponse.json()).id; report.materialId = materialId; await save()
    await page.getByLabel('材料原文', { exact: true }).waitFor()
    await page.getByRole('button', { name: '沟通准备', exact: true }).click()
    await page.getByRole('checkbox', { name: new RegExp(name.replaceAll('.', '\\.')) }).check()
    await page.getByLabel('沟通对象', { exact: true }).fill('内部合成验收项目负责人')
    await page.getByLabel('沟通目标', { exact: true }).fill('核对桌面办公范围、预算与待确认演示日期')
    const submitted = page.waitForResponse(r => r.url().endsWith('/work/tasks/') && r.request().method() === 'POST')
    const started = Date.now()
    await page.getByRole('button', { name: '生成沟通草稿', exact: true }).click()
    const created = await submitted; assert.equal(created.status(), 201)
    const task = await created.json(); taskId = task.id; runId = task.runs[0].id
    report.taskId = taskId; report.runId = runId; await save()
    for (let i = 0; i < 50; i++) {
      const current = (await api('tasks/' + taskId + '/')).body.runs.find(r => r.id === runId)
      report.run = current
      if (['succeeded', 'failed', 'canceled'].includes(current.status)) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    assert.equal(report.run.status, 'succeeded', report.run.error_code)
    assert(report.run.input_tokens > 0 && report.run.output_tokens > 0)
    report.elapsedMs = Date.now() - started
    await page.getByLabel('编辑草稿', { exact: true }).waitFor()
    body = await page.getByLabel('编辑草稿', { exact: true }).inputValue()
    }
    report.checks.uploadGenerate = true
    await save(); console.log('Installed generation verified')
    await page.screenshot({ path: path.join(output, 'work-installed-generated.png'), fullPage: true })
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByLabel('编辑草稿', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('编辑草稿', { exact: true }).inputValue(), body)
    report.checks.refresh = true
    await save(); console.log('Installed refresh verified; restarting')
    await quit(); await launch(exe)
    await page.waitForFunction(async () => (await window.weMeetDesktop.getStatus()).auth === 'signed-in')
    await page.goto(base + '/work?view=communication&task=' + taskId, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('编辑草稿', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('编辑草稿', { exact: true }).inputValue(), body)
    report.checks.restartSessionAndTask = true
    await save(); console.log('Installed restart verified')
    const destination = path.join(output, 'work-installed-draft.md')
    await app.evaluate(({ session }, destination) => {
      globalThis.workAcceptanceDownload = null
      session.fromPartition('persist:we-meet-desktop-v1').once('will-download', (_event, item) => {
        item.setSavePath(destination)
        item.once('done', (_event, state) => { globalThis.workAcceptanceDownload = { state, bytes: item.getReceivedBytes() } })
      })
    }, destination)
    await page.getByRole('button', { name: '下载 Markdown', exact: true }).click()
    for (let i = 0; i < 100; i++) {
      report.download = await app.evaluate(() => globalThis.workAcceptanceDownload)
      if (report.download) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(report.download?.state, 'completed')
    assert.equal(await fs.readFile(destination, 'utf8'), body)
    report.checks.downloadMatches = true
    await page.screenshot({ path: path.join(output, 'work-installed-restarted.png'), fullPage: true })
    assert.equal(report.pageErrors.length, 0)
    report.passed = true; console.log('Installed office upload/generate/download/restart passed')
  } catch (e) {
    report.passed = false
    report.error = String(e.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]')
    console.log(report.error); process.exitCode = 1
    await save()
    if (page) await page.screenshot({ path: path.join(output, 'work-installed-failed.png'), fullPage: true, timeout: 5000 }).catch(() => {})
  } finally {
    if (app && authenticated) {
      if (materialId) {
        try {
          report.cleanup.deleteStatus = (await api('materials/' + materialId + '/', { method: 'DELETE' })).status
          report.cleanup.detailStatus = (await api('materials/' + materialId + '/')).status
          if (runId) report.cleanup.artifactStatus = (await api('runs/' + runId + '/artifact/')).status
          assert([204, 404].includes(report.cleanup.deleteStatus) && report.cleanup.detailStatus === 404)
        } catch { report.cleanup.error = 'cleanup_failed'; report.passed = false; process.exitCode = 1 }
      }
      await page.evaluate(() => window.weMeetDesktop.logout()).catch(() => {})
      try {
        await page.waitForFunction(async () => (await window.weMeetDesktop.getStatus()).auth === 'signed-out')
        report.checks.logout = true
      } catch { report.checks.logout = false; report.passed = false; process.exitCode = 1 }
    }
    await save(); await quit(); if (browser) await browser.close()
    console.log(JSON.stringify(report))
  }
})().catch(() => { console.error('Office acceptance setup failed'); process.exitCode = 1 })
