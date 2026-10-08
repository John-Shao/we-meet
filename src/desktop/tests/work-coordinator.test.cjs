const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { WorkCoordinator } = require('../dist/work-coordinator')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-coordinate-'))
  const id = crypto.randomUUID(), workspaceId = crypto.randomUUID()
  const calls = [], jobs = new Map()
  const capabilities = { ready: true, contract: 'work-local/v1', engine: 'dsh', model: 'deepseek-flash', runtime_version: 'pin', adapter_version: '0.3.0', features: ['cloud_context', 'run_limits', 'command_approval'] }
  const meter = { calls: 0, complete: true, usage: null }
  const client = { request: async (method, body = {}) => {
    calls.push({ method, body })
    if (method === 'capabilities') return capabilities
    if (method === 'list') return [...jobs.values()]
    if (method === 'submit') { if (!jobs.has(body.run_id)) jobs.set(body.run_id, { run_id: body.run_id, state: 'running', goal: body.goal, deployment: capabilities, metering: meter, error_code: '', result: null }); return jobs.get(body.run_id) }
    if (method === 'cancel') { jobs.set(body.run_id, { ...(jobs.get(body.run_id) || { run_id: body.run_id, metering: meter }), state: 'cancelled', error_code: '' }); return jobs.get(body.run_id) }
    if (method === 'get') { if (!jobs.has(body.run_id)) throw new Error('not_found'); return jobs.get(body.run_id) }
    throw new Error('Unexpected method')
  } }
  const requests = [], reports = new Map()
  let status = 'queued', admissionLoss = false, reportLoss = false
  const deps = { remoteWorkspaces: () => [workspaceId], encrypt: value => Buffer.from(value), decrypt: value => value.toString(), request: async (endpoint, body) => {
    requests.push({ endpoint, body: structuredClone(body) })
    if (endpoint === 'local/devices/') return { contract: 'work-device/v1', device_id: body.device_id }
    if (endpoint === 'local/workspaces/') return { contract: 'work-device/v1', workspace: { id: workspaceId } }
    if (endpoint === 'local/inbox/') return { contract: 'work-device/v1', pending: [{ run_id: id, task_id: crypto.randomUUID(), workspace_id: workspaceId, workspace_label: 'folder name', goal: 'goal', model: 'deepseek-flash' }] }
    if (endpoint === 'local/tasks/') {
      if (admissionLoss) { admissionLoss = false; throw new Error('local_cloud_pending') }
      return { contract: 'work-device/v1', task: { id: 'task-id' }, run: { id: body.run_id, execution_target: 'local', status } }
    }
    if (endpoint.endsWith('/claim/')) return { contract: 'work-device/v1', workspace_id: workspaceId, run_id: id, ticket: 'a'.repeat(64), goal: 'goal', model: 'deepseek-flash', report_seq: reports.size, limits: { max_model_calls: 2, max_total_tokens: 40000, max_output_tokens: 1024 }, files: [{ name: 'context.md', text: 'authorized cloud snapshot', sha256: crypto.createHash('sha256').update('authorized cloud snapshot').digest('hex') }] }
    if (endpoint.endsWith('/report/')) {
      if (reports.has(body.seq)) assert.deepEqual(body, reports.get(body.seq)); else reports.set(body.seq, structuredClone(body))
      if (status !== 'canceled') status = body.state === 'cancelled' ? 'canceled' : body.state
      if (reportLoss) { reportLoss = false; throw new Error('local_cloud_pending') }
      return { contract: 'work-device/v1', run_id: id, report_seq: body.seq, status, cancel: status === 'canceled', uploaded_files: [] }
    }
    if (endpoint.endsWith('/cancel/')) { status = 'canceled'; return { status } }
    if (endpoint.endsWith('/sync/')) return { contract: 'work-device/v1', run_id: id, uploaded_files: body.files.map(f => f.name) }
    throw new Error('Unexpected endpoint')
  } }
  return { root, id, workspaceId, client, deps, calls, requests, jobs, reports,
    set admissionLoss(v) { admissionLoss = v }, set reportLoss(v) { reportLoss = v }, set status(v) { status = v },
    body: { run_id: id, workspace_id: workspaceId, goal: 'goal' },
    complete() {
      const text = '# private body not automatically uploaded'
      jobs.get(id).state = 'succeeded'
      jobs.get(id).result = { artifacts: ['report.md', 'private.txt'].map(name => ({ name, text, sha256: crypto.createHash('sha256').update(text).digest('hex') })) }
    }, cleanup() { fs.rmSync(root, { recursive: true, force: true }) } }
}

test('remote inbox is metadata only; fresh consent and explicit take are required', async () => {
  const f = fixture(); const c = new WorkCoordinator(f.client, f.root, f.deps)
  try {
    await c.registerWorkspace(f.workspaceId, 'folder name', true)
    const pending = await c.inbox()
    assert.equal(pending[0].run_id, f.id)
    assert.equal(f.calls.some(c => c.method === 'submit'), false)
    f.deps.remoteWorkspaces = () => []
    await assert.rejects(c.takeRemote(f.id, f.workspaceId), /workspace_permission_required/)
    f.deps.remoteWorkspaces = () => [f.workspaceId]
    await c.takeRemote(f.id, f.workspaceId)
    assert.equal(f.calls.filter(c => c.method === 'submit').length, 1)
    assert.equal(f.requests.some(r => r.endpoint === 'local/tasks/'), false)
    await c.takeRemote(f.id, f.workspaceId)
    assert.equal(f.jobs.size, 1)
    await c.close()
    const restored = new WorkCoordinator(f.client, f.root, { ...f.deps, remoteWorkspaces: () => [] })
    try {
      await assert.rejects(restored.takeRemote(f.id, f.workspaceId), /workspace_permission_required/)
    } finally { await restored.close() }
  } finally { await c.close(); f.cleanup() }
})

test('registers and claims before native execution, carries context/limits, metadata excludes text', async () => {
  const f = fixture(); const c = new WorkCoordinator(f.client, f.root, f.deps)
  try {
    const job = await c.submit(f.body, 'folder name')
    assert.equal(job.coordination.task_id, 'task-id')
    assert.equal(JSON.stringify(job).includes('a'.repeat(64)), false)
    const submit = f.calls.find(c => c.method === 'submit')
    assert.equal(submit.body.files[0].text, 'authorized cloud snapshot')
    assert.equal(submit.body.limits.max_model_calls, 2)
    assert.equal(f.requests.find(r => r.endpoint === 'local/tasks/').body.workspace_label, 'folder name')
    f.complete(); await c.get(f.id)
    const report = f.requests.filter(r => r.endpoint.endsWith('/report/')).at(-1).body
    assert.equal(JSON.stringify(report).includes('private body'), false)
    assert.equal(f.requests.some(r => r.endpoint.endsWith('/sync/')), false)
    await c.syncFiles(f.id, ['report.md'])
    assert.deepEqual(f.requests.find(r => r.endpoint.endsWith('/sync/')).body.files.map(f => f.name), ['report.md'])
  } finally { await c.close(); f.cleanup() }
})

test('lost admission survives restart as explicit confirmation, reuses UUID without replay', async () => {
  const f = fixture(); let c = new WorkCoordinator(f.client, f.root, f.deps)
  try {
    f.admissionLoss = true
    await assert.rejects(c.submit(f.body, 'folder name'), /local_cloud_pending/)
    assert.equal(f.calls.some(c => c.method === 'submit'), false)
    await c.close(); c = new WorkCoordinator(f.client, f.root, f.deps)
    assert.equal((await c.list())[0].state, 'needs_confirmation')
    assert.throws(() => c.resume(f.id, crypto.randomUUID(), 'folder name'), /workspace_permission_required/)
    const before = { native: f.calls.length, cloud: f.requests.length }
    await assert.rejects(c.submit({ ...f.body, workspace_id: crypto.randomUUID() }, 'folder name'), /workspace_permission_required/)
    assert.equal(f.calls.length, before.native)
    assert.equal(f.requests.length, before.cloud)
    await c.resume(f.id, f.workspaceId, 'folder name')
    const admissions = f.requests.filter(r => r.endpoint === 'local/tasks/')
    assert.deepEqual(admissions[0].body, admissions[1].body)
    assert.equal(f.calls.filter(c => c.method === 'submit').length, 1)
  } finally { await c.close(); f.cleanup() }
})

test('lost report ACK retries exact sequence/body after restart and does not submit again', async () => {
  const f = fixture(); let c = new WorkCoordinator(f.client, f.root, f.deps)
  try {
    f.reportLoss = true
    const job = await c.submit(f.body, 'folder name')
    assert.equal(job.coordination.error, 'local_cloud_pending')
    f.complete(); await c.close(); c = new WorkCoordinator(f.client, f.root, f.deps)
    await c.get(f.id); await c.get(f.id)
    const reports = f.requests.filter(r => r.endpoint.endsWith('/report/'))
    assert.deepEqual(reports[0].body, reports[1].body)
    assert.equal(reports[2].body.seq, 2)
    assert.equal(f.calls.filter(c => c.method === 'submit').length, 1)
  } finally { await c.close(); f.cleanup() }
})

test('cloud cancellation reaches native worker; no results are silently shared', async () => {
  const f = fixture(); const c = new WorkCoordinator(f.client, f.root, f.deps)
  try {
    await c.submit(f.body, 'folder name'); f.status = 'canceled'
    const job = await c.get(f.id)
    assert.equal(job.state, 'cancelled')
    assert.equal(f.calls.filter(c => c.method === 'cancel').length, 1)
    await assert.rejects(c.syncFiles(f.id, ['report.md']), /artifact_not_ready/)
    assert.equal(f.requests.some(r => r.endpoint.endsWith('/sync/')), false)
  } finally { await c.close(); f.cleanup() }
})
