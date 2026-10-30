#!/usr/bin/env node
/**
 * E8 golden-task rehearsal runner for the current Work R0a HTTP API.
 *
 * The runner keeps the signed golden-task definitions and pilot-ops checks.
 * It only adapts transport and template naming: the old tpl-* names map to the
 * Work builtins, and required sections are put into the input goal because the
 * current flat API has no required_sections field. This does not create pilot
 * evidence by itself: target environment, reviewer and C24/C27 contacts remain
 * external.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluateGoldenRun,
  evaluateGoldenSuite,
  validateGolden,
} from '../../docs/plan/assets/work-r0a-ops-2026-10-25/pilot-ops.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'docs/plan/assets/work-r0a-ops-2026-10-25/golden-tasks.json'),
    'utf8',
  ),
)
const TEMPLATE_MAP = {
  'tpl-report': 'analysis',
  'tpl-plan': 'draft',
  'tpl-summary': 'summary',
}
const WORK_TEMPLATE_IDS = new Set(['summary', 'analysis', 'draft'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const requestId = () => crypto.randomUUID()

const dryRun = process.argv.includes('--dry-run')
const templates = [...new Map(
  GOLDEN.tasks.map((task) => [task.template, { id: task.template, sections: task.required_sections }]),
).values()]

const errors = validateGolden(GOLDEN, templates)
for (const task of GOLDEN.tasks) {
  const mapped = TEMPLATE_MAP[task.template]
  if (!mapped || !WORK_TEMPLATE_IDS.has(mapped)) {
    errors.push(`${task.id} has no Work template mapping for ${task.template}`)
  }
}
if (errors.length) {
  console.error('golden task definitions are invalid:', errors)
  process.exit(1)
}
if (dryRun) {
  console.log(
    `golden dry-run ok: ${GOLDEN.tasks.length} tasks across ${templates.length} templates; ` +
      `mapping ${JSON.stringify(TEMPLATE_MAP)}`,
  )
  process.exit(0)
}

const baseUrl = (process.env.WORK_PILOT_BASE_URL || '').replace(/\/+$/, '')
const cookie = process.env.WORK_PILOT_SESSION_COOKIE
if (!baseUrl || !cookie) {
  console.error('set WORK_PILOT_BASE_URL (origin) and WORK_PILOT_SESSION_COOKIE')
  process.exit(1)
}
if (!/^https?:\/\/[^/]+$/.test(baseUrl)) {
  console.error('WORK_PILOT_BASE_URL must be an origin without a path, e.g. https://meet.we-meet.online')
  process.exit(1)
}
const apiRoot = `${baseUrl}/work/v1`
let csrfToken = process.env.WORK_PILOT_CSRF_TOKEN || ''

const jsonRequest = async (method, route, body) => {
  const headers = { Cookie: cookie, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken
  const response = await fetch(`${apiRoot}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!response.ok) {
    const code = data?.error?.code ?? data?.code ?? `http_${response.status}`
    throw new Error(code)
  }
  return data
}

const contentRequest = async (route) => {
  const response = await fetch(`${apiRoot}${route}`, {
    headers: { Cookie: cookie, Accept: 'text/markdown' },
  })
  if (!response.ok) throw new Error(`content_http_${response.status}`)
  return response.text()
}

const bootstrap = await jsonRequest('GET', '/bootstrap')
csrfToken = bootstrap.csrf_token
if (!csrfToken) {
  console.error('bootstrap returned no csrf_token')
  process.exit(1)
}

const terminal = new Set(['awaiting_acceptance', 'completed', 'failed', 'run_canceled', 'canceled'])

const pollTask = async (taskId, startedAt) => {
  while ((Date.now() - startedAt) / 1000 <= GOLDEN.pass_rule.max_end_to_end_seconds_p95) {
    const task = await jsonRequest('GET', `/tasks/${taskId}`)
    if (terminal.has(task.summary?.display_state)) return task
    await sleep(1000)
  }
  throw new Error(`task ${taskId} did not reach a terminal state in time`)
}

const sectionsInstruction = (sections) =>
  `\n\n请严格按以下 Markdown 章节输出：\n${sections.map((section) => `## ${section}`).join('\n')}\n需要列举步骤时使用编号列表。`

const runs = []
for (const task of GOLDEN.tasks) {
  for (let attempt = 1; attempt <= GOLDEN.pass_rule.runs_per_task; attempt += 1) {
    const startedAt = Date.now()
    try {
      const input = await jsonRequest('POST', '/inputs', {
        client_request_id: requestId(),
        goal: `${task.goal}${sectionsInstruction(task.required_sections)}`,
        background: '',
      })
      const templateId = TEMPLATE_MAP[task.template]
      const preview = await jsonRequest('POST', '/task-previews', {
        input_ref: input.input_ref,
        template_id: templateId,
        permission_mode: 'ask_each',
      })
      const submitted = await jsonRequest('POST', '/tasks', {
        client_request_id: requestId(),
        input_ref: input.input_ref,
        template_id: templateId,
        permission_mode: 'ask_each',
        preview_hash: preview.preview_hash,
      })
      const detail = await pollTask(submitted.task_id, startedAt)
      const artifact = detail.summary?.latest_artifact
      let markdown = ''
      if (artifact) {
        markdown = await contentRequest(
          `/artifacts/${artifact.artifact_id}/versions/${artifact.version_no}/content?disposition=inline`,
        )
      }
      const evaluated = evaluateGoldenRun(task, markdown)
      runs.push({
        taskId: task.id,
        attempt,
        passed: evaluated.passed,
        failed: evaluated.failed,
        manual: evaluated.manual,
        reviewerApproved: null,
        costCents: 0,
        endToEndSeconds: (Date.now() - startedAt) / 1000,
      })
    } catch (error) {
      runs.push({
        taskId: task.id,
        attempt,
        passed: false,
        failed: [String(error?.code ?? error?.message ?? error)],
        manual: [],
        reviewerApproved: null,
        costCents: 0,
        endToEndSeconds: (Date.now() - startedAt) / 1000,
      })
    }
  }
}

const suite = evaluateGoldenSuite(GOLDEN, runs)
const output = {
  version: 'work-r0a-golden-run-v1',
  generatedAt: new Date().toISOString(),
  baseUrl,
  templateMapping: TEMPLATE_MAP,
  suite,
  runs,
}
const outPath = process.env.WORK_PILOT_OUT || path.join(ROOT, 'pilot-run.json')
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`golden suite passed=${suite.passed} ratio=${suite.passRatio} p95=${suite.p95Seconds}s`)
console.log(`wrote ${outPath}`)
if (!suite.passed) process.exit(1)
