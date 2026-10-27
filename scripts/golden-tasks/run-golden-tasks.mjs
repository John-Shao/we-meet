#!/usr/bin/env node
/**
 * E8 golden-task rehearsal runner. Uses the generated Work client, polls each
 * Run to a terminal state, applies pilot-ops checks and writes a result JSON.
 * This does not create pilot evidence by itself: the target environment,
 * reviewer and C24/C27 contacts remain external.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkClient } from '../../docs/plan/assets/work-r0a-design-2026-10-25/r0a-client.mjs'
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const requestId = () => crypto.randomUUID()

const dryRun = process.argv.includes('--dry-run')
const templates = [...new Map(
  GOLDEN.tasks.map((task) => [task.template, { id: task.template, sections: task.required_sections }]),
).values()]

const errors = validateGolden(GOLDEN, templates)
if (errors.length) {
  console.error('golden task definitions are invalid:', errors)
  process.exit(1)
}
if (dryRun) {
  console.log(`golden dry-run ok: ${GOLDEN.tasks.length} tasks across ${templates.length} templates`)
  process.exit(0)
}

const baseUrl = process.env.WORK_PILOT_BASE_URL
const cookie = process.env.WORK_PILOT_SESSION_COOKIE
if (!baseUrl || !cookie) {
  console.error('set WORK_PILOT_BASE_URL and WORK_PILOT_SESSION_COOKIE')
  process.exit(1)
}

let csrfToken = process.env.WORK_PILOT_CSRF_TOKEN || ''
const client = createWorkClient({
  baseUrl,
  cookie,
  getCsrfToken: () => csrfToken,
})
const bootstrap = await client.getBootstrap()
csrfToken = bootstrap.data.csrf_token

const terminal = new Set(['awaiting_acceptance', 'completed', 'failed', 'run_canceled', 'canceled'])

const pollTask = async (taskId, startedAt) => {
  while ((Date.now() - startedAt) / 1000 <= GOLDEN.pass_rule.max_end_to_end_seconds_p95) {
    const task = await client.getTask({ path: { taskId } })
    if (terminal.has(task.data.summary.display_state)) return task.data
    await sleep(1000)
  }
  throw new Error(`task ${taskId} did not reach a terminal state in time`)
}

const runs = []
for (const task of GOLDEN.tasks) {
  for (let attempt = 1; attempt <= GOLDEN.pass_rule.runs_per_task; attempt += 1) {
    const startedAt = Date.now()
    try {
      const input = await client.createInput({
        body: {
          client_request_id: requestId(),
          goal: task.goal,
          background: '',
          media_type: 'text/markdown',
        },
      })
      const intent = {
        input_ref: input.data.input_ref,
        target: { kind: 'cloud', profile: 'text-v1' },
        template: { id: task.template, version: 1 },
        permission_mode: 'ask_each',
        output: {
          format: 'markdown',
          required_sections: task.required_sections,
        },
        connectors: [],
      }
      const preview = await client.createTaskPreview({ body: { intent } })
      const submitted = await client.submitTask({
        body: {
          client_request_id: requestId(),
          preview_hash: preview.data.preview_hash,
          intent,
        },
      })
      const detail = await pollTask(submitted.data.task.task_id, startedAt)
      const artifact = detail.summary.latest_artifact
      let markdown = ''
      if (artifact) {
        const content = await client.getArtifactContent({
          path: { artifactId: artifact.artifact_id, versionNo: artifact.version_no },
          query: { disposition: 'inline' },
        })
        markdown = content.data
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
  suite,
  runs,
}
const outPath = process.env.WORK_PILOT_OUT || path.join(ROOT, 'pilot-run.json')
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`golden suite passed=${suite.passed} ratio=${suite.passRatio} p95=${suite.p95Seconds}s`)
console.log(`wrote ${outPath}`)
if (!suite.passed) process.exit(1)
