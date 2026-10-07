// Real Work API -> main-process coordinator -> native adapter -> DeepSeek.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { LocalWorkClient, readKeyFile } = require('../dist/local-work')
const { WorkCoordinator } = require('../dist/work-coordinator')

;(async () => {
  const origin = process.env.WORK_COORDINATION_URL
  if (!origin?.startsWith('http://127.0.0.1:') || !process.env.WE_MEET_LOCAL_KEY_FILE || process.env.WORK_LOCAL_ALLOW_PAID !== '1') throw new Error('Explicit isolated API and model test opt-in required')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-real-coordination-'))
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace)
  const input = 'native-marker-9852\n'; fs.writeFileSync(path.join(workspace, 'input.txt'), input)
  const client = new LocalWorkClient({ executable: process.env.WE_MEET_LOCAL_ADAPTER, apiKey: readKeyFile(process.env.WE_MEET_LOCAL_KEY_FILE), model: 'deepseek-flash' }, path.join(root, 'state'))
  const request = async (endpoint, body) => {
    const response = await fetch(origin + '/api/v1.0/work/' + endpoint, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: 'Bearer isolated-test-account', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) })
    const value = await response.json()
    assert.equal(response.ok, true, JSON.stringify(value))
    return value
  }
  let allowed = []
  const coordinator = new WorkCoordinator(client, path.join(root, 'state'), { request, encrypt: value => Buffer.from(value), decrypt: value => value.toString(), remoteWorkspaces: () => allowed })
  try {
    const grant = await client.request('grant', { path: fs.realpathSync(workspace) })
    const runId = crypto.randomUUID()
    const remote = process.env.WORK_COORDINATION_REMOTE === '1'
    let job
    if (remote) {
      await coordinator.registerWorkspace(grant.id, 'workspace', true)
      allowed = [grant.id]
      await request('local/remote-tasks/', { run_id: runId, workspace_id: grant.id, goal: 'Read input.txt from this local folder and create report.md containing its exact contents. Preserve input.txt.' })
      const pending = await coordinator.inbox()
      assert.equal(pending[0].run_id, runId)
      assert.deepEqual(await client.request('list'), [])
      job = await coordinator.takeRemote(runId, grant.id)
    } else job = await coordinator.submit({ run_id: runId, workspace_id: grant.id, goal: 'Read input.txt from this local folder and the authorized cloud context. Write report.md containing both exact marker strings. Preserve input.txt.', sources: JSON.parse(process.env.WORK_COORDINATION_SOURCES || '[]') }, 'workspace')
    const started = Date.now()
    while (['queued', 'running'].includes(job.state) && Date.now() - started < 600000) {
      await new Promise(resolve => setTimeout(resolve, 300))
      job = await coordinator.get(runId)
      if (job.approvals?.length && process.env.WORK_COORDINATION_RECEIPT) {
        const dir = path.dirname(process.env.WORK_COORDINATION_RECEIPT)
        fs.writeFileSync(path.join(dir, 'pending-approval.json'), JSON.stringify({ run_id: runId, workspace, approvals: job.approvals }, null, 2))
        const decisionFile = path.join(dir, 'approved-fixture-operations.json')
        const decisions = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, 'utf8')) : []
        for (const a of job.approvals) if (decisions.some(d => d.id === a.id && d.sha256 === a.sha256)) await client.request('review-approval', { run_id: runId, id: a.id, sha256: a.sha256, allow: true })
      }
    }
    assert.equal(job.state, 'succeeded', job.error_code)
    const report = job.result.artifacts.find(f => f.name === 'report.md')
    assert.match(report.text, /native-marker-9852/)
    if (!remote) assert.match(report.text, /cloud-marker-4681/)
    assert.equal(fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8'), input)
    await coordinator.get(runId)
    const task = await request(`tasks/${job.coordination.task_id}/`)
    assert.equal(task.runs[0].id, runId)
    assert.equal(task.runs[0].execution_target, 'local')
    assert.equal(task.runs[0].usage_origin, 'device_reported')
    assert.equal(task.runs[0].status, 'succeeded')
    let files = await request(`runs/${runId}/files/`)
    assert.deepEqual(files, [])
    await coordinator.syncFiles(runId, ['report.md'])
    files = await request(`runs/${runId}/files/`)
    assert.deepEqual(files.map(f => f.name), ['report.md'])
    if (process.env.WORK_COORDINATION_RECEIPT) fs.writeFileSync(process.env.WORK_COORDINATION_RECEIPT, JSON.stringify({ passed: true, tested_at: new Date().toISOString(), remote_request: remote, task_id: task.id, run_id: runId, checks: ['real-WorkTask-and-WorkRun', 'same-run-UUID', remote ? 'remote-inbox-explicit-acceptance' : 'authorized-cloud-context', 'native-original-file-read', 'real-DeepSeek', 'device-reported-usage', 'no-automatic-body-upload', 'explicit-file-sync'], deployment: job.deployment, metering: job.metering, files, elapsed_ms: Date.now() - started }, null, 2))
    console.log('Real coordinated native execution and explicit sync passed')
  } finally { await coordinator.close(); await client.close(); fs.rmSync(root, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
