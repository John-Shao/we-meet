import { expect, test, type Page, type Route } from '@playwright/test'
import type { WorkTaskDetail } from '../src/features/work/r0a/api/types'

// Frontend-only browser checks: all backend responses below are mocked.
test.use({ storageState: { cookies: [], origins: [] } })

const templates = ['summary', 'plan'].map((id) => ({
  id,
  name: id === 'summary' ? '摘要整理' : '执行计划',
  description: `${id} mock template`,
  version: 1,
  sections: [],
  content_hash: `hash-${id}`,
}))
const snapshot = (cursor: string): WorkTaskDetail => ({
  summary: {
    task_id: 'browser-task',
    title: '浏览器测试任务',
    task_state: 'open',
    display_state: 'running',
    permission_mode: 'ask_each',
    active_run_id: null,
    latest_run_id: null,
    latest_run: null,
    latest_artifact: null,
    revision: 1,
    pending_acceptance: false,
    blocking_operations: 0,
    quota: { reserved_tokens: 1000, settled_tokens: 0 },
    created_at: '2026-10-29T00:00:00Z',
    updated_at: '2026-10-29T00:00:00Z',
  },
  input_ref: 'browser-input',
  goal: '生成一份工作摘要',
  background: '仅使用合成测试材料',
  template: templates[0],
  snapshot: null,
  latest_event_id: cursor,
})
const artifactReady = (cursor: string) => {
  const task = snapshot(cursor)
  task.summary.task_state = 'awaiting_acceptance'
  task.summary.display_state = 'awaiting_acceptance'
  task.summary.pending_acceptance = true
  task.summary.latest_artifact = {
    artifact_id: 'browser-artifact',
    version_no: 1,
    content_hash: 'artifact-hash',
  }
  return task
}
const event = (cursor: string) =>
  `id: ${cursor}\nevent: artifact.published\ndata: ${JSON.stringify({
    event_id: 'published-event',
    task_id: 'browser-task',
    seq: 2,
    type: 'artifact.published',
    schema_version: '1',
    occurred_at: '2026-10-29T00:00:01Z',
    payload: {},
  })}\n\n`
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const fulfill = (route: Route, json: unknown, status = 200) =>
  route.fulfill({ status, json })

const mockBackend = async (page: Page) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'zh')
  })
  await page.route('**/api/v1.0/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/config/')) {
      return fulfill(route, {
        is_silent_login_enabled: false,
        feedback: { url: '' },
        subtitle: { enabled: false },
        telephony: { enabled: false },
        livekit: { url: '', default_sources: [] },
        background_image: {
          upload_is_enabled: false,
          max_size: 0,
          max_count_by_user: 0,
          allowed_extensions: [],
          allowed_mimetypes: [],
        },
      })
    }
    if (path.includes('/users/me')) {
      return fulfill(route, {
        id: 'browser-user',
        email: 'browser@example.test',
        full_name: 'Browser Test',
        last_name: 'Test',
        language: 'zh',
        timezone: 'Asia/Shanghai',
      })
    }
    return fulfill(route, { results: [], count: 0, items: [] })
  })
  await page.route('**/work/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/bootstrap'))
      return fulfill(route, {
        subject_id: 'browser-user',
        org: {
          id: 'browser-org',
          name: 'Mock browser organization',
          role: 'member',
          work_seat: true,
        },
        permissions: [],
        phases: ['R0a'],
        execution_targets: [],
        allowed_permission_modes: ['ask_each', 'auto_readonly'],
        limits: {
          max_goal_chars: 2000,
          max_background_chars: 4000,
          max_artifact_bytes: 262144,
          max_active_runs: 3,
        },
        csrf_token: 'mock-csrf',
      })
    if (path.endsWith('/templates')) return fulfill(route, { items: templates })
    if (path.endsWith('/inputs'))
      return fulfill(route, {
        input_ref: 'browser-input',
        content_hash: 'input-hash',
        bytes: 100,
        expires_at: '',
      })
    if (path.endsWith('/task-previews')) {
      const body = route.request().postDataJSON()
      return fulfill(route, {
        preview_hash: `preview-${body.template_id}-${body.permission_mode}`,
        expires_at: '',
        token_upper_bound: 1000,
        template: templates.find(
          (template) => template.id === body.template_id
        ),
        input_ref: body.input_ref,
        input_hash: 'input-hash',
        input_bytes: 100,
      })
    }
    if (path.endsWith('/tasks')) {
      if (route.request().method() === 'POST')
        return fulfill(
          route,
          {
            task_id: 'browser-task',
            run_id: 'browser-run',
            revision: 1,
            task_state: 'open',
            display_state: 'queued',
            input_ref: 'browser-input',
          },
          202
        )
      return fulfill(route, { items: [], next_cursor: null })
    }
    if (path.endsWith('/content'))
      return route.fulfill({
        contentType: 'text/markdown',
        body: '# Mock final artifact\n\nThe reconnect gap event was recovered.',
      })
    return fulfill(route, { code: 'unmocked_endpoint' }, 404)
  })
  return errors
}

test('mocked golden path: preview, submit, gap event, artifact, acceptance', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  let task = snapshot('snapshot-before-stream')
  const cursors: (string | undefined)[] = []
  await page.route('**/work/v1/tasks/browser-task', (route) =>
    fulfill(route, task)
  )
  await page.route('**/work/v1/tasks/browser-task/events', async (route) => {
    cursors.push(route.request().headers()['last-event-id'])
    task = artifactReady('after-gap-event')
    await route.fulfill({
      contentType: 'text/event-stream',
      body: event('after-gap-event'),
    })
  })
  await page.route('**/work/v1/tasks/browser-task/acceptances', (route) => {
    task = {
      ...task,
      summary: {
        ...task.summary,
        task_state: 'completed',
        display_state: 'completed',
      },
    }
    return fulfill(route, {
      task: task.summary,
      acceptance: { id: 'accepted' },
    })
  })
  await page.goto('/work/new')
  await page.getByLabel('任务描述', { exact: true }).fill('生成一份工作摘要')
  await page.getByRole('button', { name: '预览并发送', exact: true }).click()
  await expect(page.getByText('Token 上限', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认发送', exact: true }).click()
  await expect(page).toHaveURL(/\/work\/items\/browser-task$/)
  await page.getByRole('button', { name: '查看成果', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Mock final artifact' })
  ).toBeVisible()
  expect(cursors).toEqual(['snapshot-before-stream'])
  await page.getByRole('button', { name: '确认采纳', exact: true }).click()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

for (const [stage, field] of [
  ['inputs', 'goal'],
  ['task-previews', 'background'],
  ['inputs', 'template'],
  ['task-previews', 'mode'],
] as const) {
  test(`mocked delayed ${stage}: editing ${field} requires a fresh preview`, async ({
    page,
  }) => {
    const errors = await mockBackend(page)
    const pending = deferred()
    let calls = 0
    await page.route(`**/work/v1/${stage}`, async (route) => {
      calls += 1
      if (calls === 1) await pending.promise
      await route.fallback()
    })
    await page.goto('/work/new')
    await page.getByLabel('任务描述', { exact: true }).fill('原始测试目标')
    await page.getByRole('button', { name: '预览并发送', exact: true }).click()
    await expect.poll(() => calls).toBe(1)
    if (field === 'goal')
      await page.getByLabel('任务描述', { exact: true }).fill('编辑后的目标')
    if (field === 'background')
      await page.getByLabel('补充背景', { exact: true }).fill('编辑后的背景')
    if (field === 'template')
      await page.getByRole('button', { name: /执行计划/ }).click()
    if (field === 'mode')
      await page.getByRole('button', { name: /自动执行只读操作/ }).click()
    pending.resolve()
    await expect(
      page.getByRole('button', { name: '预览并发送', exact: true })
    ).toBeEnabled()
    await expect(
      page.getByRole('button', { name: '确认发送', exact: true })
    ).toHaveCount(0)
    await page.getByRole('button', { name: '预览并发送', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '确认发送', exact: true })
    ).toBeVisible()
    expect(calls).toBe(2)
    expect(errors).toEqual([])
  })
}

test('mocked 409: failed/delayed snapshot blocks streams; fresh cursor recovers the final artifact', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  const pending = deferred()
  let details = 0
  let streams = 0
  const cursors: (string | undefined)[] = []
  await page.route('**/work/v1/tasks/browser-task', async (route) => {
    details += 1
    if (details === 1) return fulfill(route, snapshot('expired-snapshot'))
    if (details === 2) return fulfill(route, { code: 'service_degraded' }, 503)
    if (details === 3) {
      await pending.promise
      return fulfill(route, snapshot('fresh-snapshot'))
    }
    return fulfill(route, artifactReady('gap-final'))
  })
  await page.route('**/work/v1/tasks/browser-task/events', async (route) => {
    streams += 1
    cursors.push(route.request().headers()['last-event-id'])
    if (streams === 1)
      return route.fulfill({
        status: 409,
        headers: { 'X-Work-Event-Cursor': 'unsafe-header' },
        json: { code: 'resync_required' },
      })
    return route.fulfill({
      contentType: 'text/event-stream',
      body: event('gap-final'),
    })
  })
  await page.goto('/work/items/browser-task')
  await expect.poll(() => details).toBe(3)
  await page.clock.install()
  await page.clock.fastForward(30_000)
  expect(streams).toBe(1)
  pending.resolve()
  await page.getByRole('button', { name: '查看成果', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Mock final artifact' })
  ).toBeVisible({ timeout: 10_000 })
  expect(cursors).toEqual(['expired-snapshot', 'fresh-snapshot'])
  expect(errors).toEqual([])
})
