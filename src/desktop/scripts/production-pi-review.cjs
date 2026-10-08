// One explicit review of an existing synthetic result, using real production APIs.
// OTP bootstrap is a fixture; native login UX is not part of this acceptance.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

;(async () => {
  assert.equal(process.env.WORK_PRODUCTION_PI_REVIEW, '1')
  const output = path.resolve(process.env.WORK_CROSS_DEVICE_OUTPUT)
  assert.ok(output.startsWith(path.resolve(__dirname, '../../../.work-acceptance') + path.sep))
  const source = JSON.parse(fs.readFileSync(path.join(output, 'desktop-receipt.json')))
  const failed = JSON.parse(fs.readFileSync(path.join(output, 'pi-review-terminal.json')))
  assert.equal(source.passed, true)
  assert.equal(failed.source_run_id, source.run_id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'budget_exceeded')
  assert.equal(failed.input_tokens, 0); assert.equal(failed.output_tokens, 0)
  assert.ok(!fs.existsSync(path.join(output, 'pi-review-second-started.json')), 'No automatic paid retry')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-production-pi-'))
  const profile = path.join(root, 'profile')
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: 'https://meet.we-meet.online', WEMEET_OIDC_ISSUER: 'https://id.we-meet.online/realms/meet' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env, timeout: 30000 })
    return app.firstWindow()
  }
  const close = async () => {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) }).catch(() => {})
      await app.close(); app = undefined
    }
  }
  try {
    let page = await launch()
    await page.waitForFunction(() => !!window.weMeetDesktop)
    const response = await fetch('http://127.0.0.1:48763/desktop', { redirect: 'error' })
    assert.equal(response.status, 200)
    let session = await response.json()
    await app.evaluate(({ app, safeStorage }, fixture) => {
      if (app.getPath('userData') !== fixture.profile) throw Error('Wrong profile')
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
      fs.writeFileSync(path.join(fixture.profile, 'session-v1.enc'), safeStorage.encryptString(JSON.stringify({
        issuer: 'https://id.we-meet.online/realms/meet', serviceOrigin: 'https://meet.we-meet.online', clientId: 'desktop', tokens: fixture.session,
      })))
    }, { profile, session })
    session = undefined
    await close(); page = await launch(); page.setDefaultTimeout(30000)
    await page.goto(`https://meet.we-meet.online/work?view=new&execution=cloud&task=${source.task_id}`)
    const request = endpoint => page.evaluate(async endpoint => {
      const response = await fetch('/api/v1.0/work/' + endpoint, { redirect: 'error' })
      if (!response.ok) throw Error('Business request failed')
      return response.json()
    }, endpoint)
    const caps = await request('capabilities/')
    assert.equal(caps.review_enabled, true); assert.equal(caps.review_model, 'qwen3.8-flash')
    assert.equal(caps.review_token_budget, 20000); assert.equal(caps.agent_enabled, false)
    assert.deepEqual((await request(`runs/${source.run_id}/reviews/`)).map(r => r.id), [failed.id])
    const selected = failed.selection
    assert.deepEqual((await request(`runs/${source.run_id}/files/`)).map(({ name, sha256 }) => ({ name, sha256 })), selected)
    const ui = page.getByRole('region', { name: '成果复核', exact: true })
    await ui.waitFor()
    await ui.getByLabel('report.md', { exact: true }).check()
    await ui.getByLabel('同意将选定成果和本任务已授权材料发送至复核模型').check()
    fs.writeFileSync(path.join(output, 'pi-review-second-started.json'), JSON.stringify({ source_run_id: source.run_id, prior_failed_review: failed.id, budget: 20000, max_model_calls: 1 }))
    await ui.getByRole('button', { name: '开启本次复核', exact: true }).click()
    let review
    for (const deadline = Date.now() + 300000; Date.now() < deadline;) {
      const reviews = await request(`runs/${source.run_id}/reviews/`)
      assert.ok(reviews.length <= 2)
      review = reviews.find(r => r.id !== failed.id)
      if (review && !['queued', 'running'].includes(review.status)) break
      await page.waitForTimeout(1500)
    }
    fs.writeFileSync(path.join(output, 'pi-review-second-terminal.json'), JSON.stringify(review || {}, null, 2))
    assert.equal(review?.status, 'succeeded', review?.error_code)
    assert.equal(review.model, 'qwen3.8-flash'); assert.deepEqual(review.selection, selected)
    assert.ok(Number.isInteger(review.input_tokens) && review.input_tokens >= 0)
    assert.ok(Number.isInteger(review.output_tokens) && review.output_tokens >= 0)
    assert.ok(review.input_tokens + review.output_tokens <= 20000)
    assert.ok(['no_issues', 'needs_changes', 'inconclusive'].includes(review.report.verdict))
    await ui.getByRole('heading', { name: '复核完成', exact: true }).waitFor()
    await page.screenshot({ path: path.join(output, 'desktop-pi-review.png'), animations: 'disabled', fullPage: true })
    assert.deepEqual((await request(`runs/${source.run_id}/files/`)).map(({ name, sha256 }) => ({ name, sha256 })), selected)
    fs.writeFileSync(path.join(output, 'pi-review-receipt.json'), JSON.stringify({ passed: true, source_run_id: source.run_id,
      review_id: review.id, model: review.model, input_tokens: review.input_tokens, output_tokens: review.output_tokens,
      verdict: review.report.verdict, files: selected, separate_consent: true, synced_result_unchanged: true,
      desktop_review_visible: true, prior_failed_review_retained: failed.id, native_login_ux: false }, null, 2))
    // Logout navigates away and destroys the invoking renderer context.
    try { await page.evaluate(() => { void window.weMeetDesktop.logout().catch(() => {}); return true }) } catch (error) { if (!error.message.includes('Execution context was destroyed')) throw error }
    await page.waitForFunction(async () => (await window.weMeetDesktop.getStatus()).auth === 'signed-out')
    assert.equal(await app.evaluate(({ app }) => process.getBuiltinModule('fs').existsSync(process.getBuiltinModule('path').join(app.getPath('userData'), 'session-v1.enc'))), false)
    console.log('Production Pi report verified in desktop UI; prior failure retained')
  } finally {
    await close()
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('meet-production-pi-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})().catch(error => { console.error('Production Pi acceptance failed:', error.name); process.exitCode = 1 })
