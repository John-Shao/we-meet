import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'run-golden-tasks.mjs')
const UUID = '11111111-1111-4111-8111-111111111111'
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(HERE, '../../docs/plan/assets/work-r0a-ops-2026-10-25/golden-tasks.json'), 'utf8'),
)
const ALL_SECTIONS = [...new Set(GOLDEN.tasks.flatMap((task) => task.required_sections))]
const MARKDOWN = [
  '# 建议',
  '',
  ...ALL_SECTIONS.flatMap((section) => [`## ${section}`, '', `本节给出${section}的可执行说明。`.repeat(6), '']),
  '1. 第一步执行',
  '2. 第二步复核',
].join('\n')

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

test('golden runner uses the current flat Work API contract', async () => {
  const calls = { inputs: 0, previews: 0, submits: 0, polls: 0, contents: 0 }
  const requests = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const bodyText = await readBody(request)
    requests.push({ method: request.method, path: url.pathname, headers: request.headers, body: bodyText })
    if (url.pathname === '/work/v1/bootstrap' && request.method === 'GET') {
      return json(response, 200, { csrf_token: 'csrf-token' })
    }
    if (request.method !== 'GET') {
      assert.equal(request.headers['x-csrf-token'], 'csrf-token', `missing CSRF on ${url.pathname}`)
    }
    if (url.pathname === '/work/v1/inputs' && request.method === 'POST') {
      const body = JSON.parse(bodyText)
      assert.equal(typeof body.client_request_id, 'string')
      assert.equal(typeof body.goal, 'string')
      assert.equal(body.background, '')
      assert.match(body.goal, /^## /m)
      calls.inputs += 1
      return json(response, 201, { input_ref: UUID })
    }
    if (url.pathname === '/work/v1/task-previews' && request.method === 'POST') {
      const body = JSON.parse(bodyText)
      assert.equal(body.input_ref, UUID)
      assert.ok(['summary', 'analysis', 'draft'].includes(body.template_id))
      assert.equal(body.permission_mode, 'ask_each')
      calls.previews += 1
      return json(response, 200, { preview_hash: `sha256:${'a'.repeat(64)}` })
    }
    if (url.pathname === '/work/v1/tasks' && request.method === 'POST') {
      const body = JSON.parse(bodyText)
      assert.equal(body.input_ref, UUID)
      assert.ok(['summary', 'analysis', 'draft'].includes(body.template_id))
      assert.equal(body.permission_mode, 'ask_each')
      assert.equal(body.preview_hash, `sha256:${'a'.repeat(64)}`)
      calls.submits += 1
      return json(response, 202, { task_id: UUID, run_id: UUID, display_state: 'queued' })
    }
    if (url.pathname === `/work/v1/tasks/${UUID}` && request.method === 'GET') {
      calls.polls += 1
      return json(response, 200, {
        summary: {
          display_state: 'awaiting_acceptance',
          latest_artifact: { artifact_id: UUID, version_no: 1 },
        },
      })
    }
    if (url.pathname === `/work/v1/artifacts/${UUID}/versions/1/content` && request.method === 'GET') {
      calls.contents += 1
      response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
      response.end(MARKDOWN)
      return
    }
    json(response, 404, { error: { code: 'not_found' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-golden-test-'))
  const outPath = path.join(directory, 'pilot-run.json')
  try {
    const { port } = server.address()
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        WORK_PILOT_BASE_URL: `http://127.0.0.1:${port}`,
        WORK_PILOT_SESSION_COOKIE: 'sessionid=test',
        WORK_PILOT_OUT: outPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    const exitCode = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(exitCode, 0, stderr)
    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    assert.equal(result.suite.passed, true)
    assert.equal(result.runs.length, GOLDEN.tasks.length * GOLDEN.pass_rule.runs_per_task)
    assert.equal(calls.inputs, GOLDEN.tasks.length * GOLDEN.pass_rule.runs_per_task)
    assert.equal(calls.previews, calls.inputs)
    assert.equal(calls.submits, calls.inputs)
    assert.equal(calls.contents, calls.inputs)
    assert.ok(calls.polls >= calls.inputs)
    assert.ok(requests.every((request) => !request.path.includes('/v1/task-previews/intent')))
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('golden runner preflight checks session and task reads without creating tasks', async () => {
  const calls = { gets: [], posts: 0 }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'POST') calls.posts += 1
    calls.gets.push(`${url.pathname}${url.search}`)
    if (request.method === 'GET' && url.pathname === '/work/v1/bootstrap') {
      return json(response, 200, { csrf_token: 'csrf-token' })
    }
    if (request.method === 'GET' && url.pathname === '/work/v1/tasks') {
      assert.equal(url.searchParams.get('limit'), '1')
      return json(response, 200, { items: [], next_cursor: null })
    }
    json(response, 404, { error: { code: 'not_found' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const child = spawn(process.execPath, [SCRIPT, '--preflight'], {
      env: {
        ...process.env,
        WORK_PILOT_BASE_URL: `http://127.0.0.1:${port}`,
        WORK_PILOT_SESSION_COOKIE: 'sessionid=test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    const exitCode = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(exitCode, 0, stderr)
    assert.match(stdout, /golden preflight ok/)
    assert.equal(calls.posts, 0)
    assert.deepEqual(calls.gets, ['/work/v1/bootstrap', '/work/v1/tasks?limit=1'])
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
