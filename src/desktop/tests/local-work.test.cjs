const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { LocalWorkClient, readKeyFile } = require('../dist/local-work')

test('key import validates a bounded explicit env file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-local-'))
  try {
    const file = path.join(root, 'key.env')
    fs.writeFileSync(file, 'DEEPSEEK_API_KEY=sk-synthetic-test-only-123456\n')
    assert.equal(readKeyFile(file), 'sk-synthetic-test-only-123456')
    fs.writeFileSync(file, '\uFEFFDEEPSEEK_API_KEY=sk-synthetic-test-only-123456\n')
    assert.equal(readKeyFile(file), 'sk-synthetic-test-only-123456')
    fs.writeFileSync(file, 'DEEPSEEK_API_KEY=not-a-key')
    assert.throws(() => readKeyFile(file), /invalid_key_file/)
    fs.writeFileSync(file, 'x'.repeat(4097))
    assert.throws(() => readKeyFile(file), /invalid_key_file/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('own stdio contract frames split UTF8, scrubs business env and closes on EOF', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-local-'))
  const executable = path.join(root, 'work-agent-local.exe')
  fs.writeFileSync(executable, '')
  const original = cp.spawn
  let launch
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.pid = 123; child.exitCode = null; child.signalCode = null
  child.stdin.on('data', buffer => {
    const command = JSON.parse(buffer.toString())
    const result = Buffer.from(JSON.stringify({ contract: 'work-local/v1', id: command.id, result: { ready: true, name: '本地文件夹' } }) + '\n')
    child.stdout.write(result.subarray(0, result.length - 4)); child.stdout.write(result.subarray(result.length - 4))
  })
  child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0) })
  cp.spawn = (binary, args, options) => { launch = { binary, args, options }; return child }
  const oldSecret = process.env.WORK_AGENT_TOKEN
  process.env.WORK_AGENT_TOKEN = 'business-secret-not-for-local-runtime'
  try {
    const client = new LocalWorkClient({ executable, apiKey: 'sk-synthetic-test-only-123456', model: 'deepseek-flash' }, path.join(root, 'state'))
    assert.equal((await client.request('capabilities')).name, '本地文件夹')
    assert.equal(launch.options.shell, false)
    assert.equal(launch.options.windowsHide, true)
    assert.equal(launch.options.env.WORK_AGENT_TOKEN, undefined)
    assert.equal(launch.options.env.DEEPSEEK_API_KEY, 'sk-synthetic-test-only-123456')
    assert.equal(launch.args.includes('sk-synthetic-test-only-123456'), false)
    await client.request('submit', { files: [{ text: 'cloud context '.repeat(8000) }] })
    await assert.rejects(client.request('submit', { files: [{ text: 'x'.repeat(512000) }] }), /invalid_local_request/)
    await client.close()
  } finally {
    cp.spawn = original
    if (oldSecret === undefined) delete process.env.WORK_AGENT_TOKEN; else process.env.WORK_AGENT_TOKEN = oldSecret
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('actual packaged stdio adapter handshake and native grant', { skip: !process.env.WE_MEET_LOCAL_ADAPTER }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-native-'))
  const workspace = path.join(root, '本地 workspace'); fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'input.txt'), 'Only in local folder: marker-7319\n')
  const client = new LocalWorkClient({ executable: process.env.WE_MEET_LOCAL_ADAPTER, apiKey: process.env.WE_MEET_LOCAL_KEY_FILE ? readKeyFile(process.env.WE_MEET_LOCAL_KEY_FILE) : 'sk-synthetic-test-only-123456', model: 'deepseek-flash' }, path.join(root, 'state'))
  try {
    const capabilities = await client.request('capabilities')
    assert.equal(capabilities.engine, 'dsh'); assert.equal(capabilities.execution, 'local'); assert.equal(capabilities.ready, true)
    const grant = await client.request('grant', { path: fs.realpathSync(workspace) })
    assert.equal(grant.path, fs.realpathSync(workspace))
    assert.deepEqual(await client.request('list'), [])
    if (process.env.WORK_LOCAL_ALLOW_PAID !== '1') return
    const runId = crypto.randomUUID()
    let job = await client.request('submit', { run_id: runId, workspace_id: grant.id, goal: 'Read input.txt from this local workspace and write report.md containing its exact contents. Do not modify input.txt.' })
    const started = Date.now()
    while (['queued', 'running'].includes(job.state) && Date.now() - started < 200000) {
      await new Promise(resolve => setTimeout(resolve, 100))
      job = await client.request('get', { run_id: runId })
    }
    assert.equal(job.state, 'succeeded', job.error_code)
    assert.equal(job.metering.complete, true)
    const artifact = job.result.artifacts.find(item => item.name === 'report.md')
    assert.match(artifact.text, /marker-7319/)
    const file = await client.request('artifact-path', { run_id: runId, name: 'report.md' })
    assert.equal(path.relative(workspace, file.path).startsWith('..'), false)
    assert.equal(fs.readFileSync(file.path, 'utf8'), artifact.text)
    if (process.env.WORK_LOCAL_BRIDGE_RECEIPT) fs.writeFileSync(process.env.WORK_LOCAL_BRIDGE_RECEIPT, JSON.stringify({ path: 'Electron main LocalWorkClient -> stdio adapter -> native dsh cwd -> local model broker -> DeepSeek -> workspace file', wall_ms: Date.now() - started, job }, null, 2))
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
