#!/usr/bin/env node
/**
 * E8 golden-task rehearsal runner for the current Work R0a HTTP API.
 *
 * The runner keeps the signed golden-task definitions and pilot-ops checks.
 * It only adapts transport and template naming: the old tpl-* names map to the
 * Work builtins, and required sections are put into the input goal because the
 * current flat API has no required_sections field. This does not create pilot
 * evidence by itself: target environment, reviewer and C24/C27 contacts remain
 * external. `--preflight` checks the session, CSRF and task read path without
 * creating tasks; only a real run creates the 18 golden tasks. The live suite
 * paces submissions with WORK_PILOT_MIN_INTERVAL_MS (default 24000) so the
 * start rate stays at or below the pilot's 2.5 starts/minute assumption.
 * A `waiting(reconcile)` run is recorded as a failed attempt immediately:
 * the runner has no reconcile path, and the 2/3 per-task rule already permits
 * a transient failure without forcing a 180s p95 miss.
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
const minIntervalMs = Number(process.env.WORK_PILOT_MIN_INTERVAL_MS ?? 24_000)
let lastSubmitAt = 0
const paceSubmit = async () => {
  const waitMs = lastSubmitAt + minIntervalMs - Date.now()
  if (waitMs > 0) await sleep(waitMs)
  lastSubmitAt = Date.now()
}

const dryRun = process.argv.includes('--dry-run')
const preflight = process.argv.includes('--preflight')
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
if (preflight) {
  const page = await jsonRequest('GET', '/tasks?limit=1')
  if (!Array.isArray(page?.items)) {
    console.error('task list returned no items array')
    process.exit(1)
  }
  console.log(
    `golden preflight ok: bootstrap, csrf and task list readable (${page.items.length} task(s) in first page)`,
  )
}

// A preflight run stops after the read checks; the live suite below is skipped.
if (!preflight) {
const terminal = new Set(['awaiting_acceptance', 'completed', 'failed', 'run_canceled', 'canceled'])

const pollTask = async (taskId, startedAt) => {
  while ((Date.now() - startedAt) / 1000 <= GOLDEN.pass_rule.max_end_to_end_seconds_p95) {
    const task = await jsonRequest('GET', `/tasks/${taskId}`)
    if (terminal.has(task.summary?.display_state)) return task
    // The runner cannot reconcile a provider_unknown run; waiting the full
    // p95 deadline would turn one transient failure into a suite-wide p95 miss.
    const run = task.summary?.latest_run
    if (run?.state === 'waiting' && run.wait_reason === 'reconcile') {
      throw new Error('waiting_reconcile')
    }
    await sleep(1000)
  }
  throw new Error(`task ${taskId} did not reach a terminal state in time`)
}

const sectionsInstruction = (sections) =>
  `\n\n请严格按以下 Markdown 章节输出：\n${sections.map((section) => `## ${section}`).join('\n')}\n需要列举步骤时使用编号列表。`

const BACKGROUNDS = {
  G01: '合成背景：公司目前使用一套内部报销工具，员工提交纸质或表格申请，财务人工核对发票和预算。常见问题包括重复录入、审批链不透明、移动端体验差、月末集中提交导致积压。部门负责人关注改版后能否减少财务工作量、缩短报销周期并保留审计记录。现有系统与考勤、采购和财务共享中心有接口，改造需要评估数据迁移、权限分离和培训成本。',
  G02: '合成背景：客服团队当前采用固定早中晚三班，每班人数按历史来电量估算。高峰期等待时长上升，夜间人力闲置；临时调班依赖主管手工协调。可选方案包括固定班、弹性班、按小时排班和外包峰值支援。约束包括劳动时长合规、培训周期、系统排班接口和员工公平感。管理层希望比较两种主要排班方式的优缺点，并给出可执行建议。',
  G03: '合成背景：本季度培训计划覆盖新员工、业务骨干和管理者三类角色，主题包括产品知识、客户沟通、数据分析和合规。预算有限，讲师以内训为主，部分课程可外采。培训需要与季度业务节奏错开，并安排考核与复盘。目标是把计划拆成可执行步骤、明确负责人角色、依赖和验收标准。',
  G04: '合成背景：公司计划在两周内从现址搬迁到同城新办公室，涉及行政、IT、财务、业务等部门。需要盘点工位、网络、服务器、合同、固定资产和档案，安排打包、运输、安装和验收。搬迁窗口只能利用周末，业务不能中断。目标是列出准备清单、负责人角色、依赖和验收标准。',
  G05: '合成项目周会记录（虚构）：参会角色包括项目经理、产品负责人、研发负责人、测试负责人和运营负责人。项目目标是本季度上线新流程。研发报告核心接口已完成，测试发现两个高优先级缺陷；产品确认范围不变，运营准备培训材料。会议决定本周冻结需求，下周完成回归；风险是供应商接口延迟和数据迁移窗口不足。待办包括修复缺陷、补充监控、更新上线清单和安排演练。以上内容为合成数据，不含客户信息。',
  G06: '合成客户反馈汇总（虚构）：客户 A 反映登录步骤多、移动端加载慢；客户 B 希望导出格式更灵活；客户 C 关注权限设置和审计记录。共性问题集中在易用性、性能和权限可见性。建议按影响面和实现成本排序处理：先修复登录与加载问题，再补充导出模板，最后完善权限说明和审计查询。以上为合成反馈，不含真实客户数据。',
}

const backgroundFor = (task) => {
  const base = BACKGROUNDS[task.id] || `合成背景：本任务用于 E8 演练，不含客户数据。目标：${task.goal}`
  const target = Number(task.background_chars) || 0
  let text = ''
  while ([...text].length < target) text += (text ? '\n\n' : '') + base
  return [...text].slice(0, target).join('')
}

const runs = []
for (const task of GOLDEN.tasks) {
  for (let attempt = 1; attempt <= GOLDEN.pass_rule.runs_per_task; attempt += 1) {
    const startedAt = Date.now()
    try {
      await paceSubmit()
      const input = await jsonRequest('POST', '/inputs', {
        client_request_id: requestId(),
        goal: `${task.goal}${sectionsInstruction(task.required_sections)}`,
        background: backgroundFor(task),
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
}
