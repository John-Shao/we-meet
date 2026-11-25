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
        phases: ['R0a', 'R0b'],
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
    if (path.endsWith('/operations')) {
      return fulfill(route, {
        items: [
          {
            id: 'browser-operation-model',
            run_id: 'browser-run',
            logical_key: 'model:1',
            kind: 'model',
            state: 'authorized',
            request_hash: 'sha256:browser-model',
            provider_request_id: 'browser-req-1',
            receipt_ref: null,
            revision: 2,
            created_at: '2026-10-31T00:00:00Z',
            updated_at: '2026-10-31T00:00:05Z',
          },
          {
            id: 'browser-operation-tool',
            run_id: 'browser-run',
            logical_key: 'tool:1',
            kind: 'tool',
            state: 'unresolved',
            request_hash: 'sha256:browser-tool',
            provider_request_id: null,
            receipt_ref: null,
            revision: 0,
            created_at: '2026-10-31T00:00:01Z',
            updated_at: '2026-10-31T00:00:01Z',
          },
        ],
        next_cursor: null,
      })
    }
    if (path.endsWith('/inbox')) {
      return fulfill(route, { items: [], next_cursor: null })
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
  await page.route('**/work/v2/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/reconciliations')) {
      return fulfill(route, {
        org_id: 'browser-org',
        run_id: 'browser-run',
        task_id: 'browser-task',
        run_state: 'active',
        wait_reason: null,
        blocking: { new_run: false, acceptance: false },
        items: [],
      })
    }
    if (path.endsWith('/readonly-grants')) {
      return fulfill(route, { grants: [] })
    }
    if (path.endsWith('/supersede-budgets')) {
      return fulfill(route, { run_id: 'browser-run', steps: [] })
    }
    return fulfill(route, { code: 'unmocked_endpoint' }, 404)
  })
  return errors
}

test('mocked golden path: preview, submit, gap event, artifact, acceptance', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  let task = snapshot('snapshot-before-stream')
  // The mocked detail has no run, and the operations panel needs one to render:
  // the folded tool group is precisely the behaviour worth checking in a real
  // browser rather than only in a component test.
  task.summary.latest_run_id = 'browser-run'
  const cursors: (string | undefined)[] = []
  await page.route('**/work/v1/tasks/browser-task', (route) =>
    fulfill(route, task)
  )
  await page.route('**/work/v1/tasks/browser-task/events', async (route) => {
    cursors.push(route.request().headers()['last-event-id'])
    task = artifactReady('after-gap-event')
    task.summary.latest_run_id = 'browser-run'
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
  // D5 §5.3: model and artifact steps stay visible, tool calls fold. The state
  // label is localized, so the raw enum must not appear anywhere.
  await expect(
    page.getByRole('heading', { name: '运行步骤', exact: true })
  ).toBeVisible()
  await expect(page.getByText('model:1', { exact: true })).toBeVisible()
  await expect(page.getByText('已授权', { exact: true })).toBeVisible()
  const toolToggle = page.getByText('工具步骤（1）', { exact: true })
  await expect(toolToggle).toBeVisible()
  await expect(page.getByText('tool:1', { exact: true })).toBeHidden()
  await toolToggle.click()
  await expect(page.getByText('tool:1', { exact: true })).toBeVisible()
  await expect(page.getByText('unresolved', { exact: true })).toBeHidden()
  await page.getByRole('button', { name: '查看成果', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Mock final artifact' })
  ).toBeVisible()
  expect(cursors).toEqual(['snapshot-before-stream'])
  await page.getByRole('button', { name: '确认采纳', exact: true }).click()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('mocked sixth supersede: shows n/5 and only real re-preview or end Run exits', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  const task = snapshot('supersede-limit')
  task.summary.latest_run_id = 'browser-run'
  task.summary.latest_run = {
    id: 'browser-run',
    task_id: 'browser-task',
    attempt_no: 1,
    state: 'waiting',
    wait_reason: 'input',
    terminal_reason: null,
    control_revision: 12,
    runtime_version: 'fixture',
    created_at: '2026-10-31T00:00:00Z',
    updated_at: '2026-10-31T00:00:10Z',
  }
  await page.route('**/work/v1/tasks/browser-task', (route) =>
    fulfill(route, task)
  )
  await page.route('**/work/v1/tasks/browser-task/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' })
  )
  await page.route('**/work/v1/runs/browser-run/operations**', (route) =>
    fulfill(route, {
      items: [
        {
          id: 'browser-operation-limit',
          run_id: 'browser-run',
          logical_key: 'tool:1#5',
          kind: 'model',
          state: 'waiting_approval',
          request_hash: 'sha256:browser-limit',
          provider_request_id: null,
          receipt_ref: null,
          revision: 5,
          created_at: '2026-10-31T00:00:00Z',
          updated_at: '2026-10-31T00:00:10Z',
        },
      ],
      next_cursor: null,
    })
  )
  let activeSupersedeCount = 2
  await page.route('**/work/v2/runs/browser-run/supersede-budgets**', (route) =>
    fulfill(route, {
      run_id: 'browser-run',
      steps: [
        {
          step_key: 'tool:1',
          supersede_no: 5,
          active_supersede_count: activeSupersedeCount,
          active_supersede_limit: 5,
          limit_reached: activeSupersedeCount >= 5,
        },
      ],
    })
  )
  let canceled = false
  await page.route('**/work/v1/runs/browser-run/cancel', (route) => {
    canceled = route.request().method() === 'POST'
    return fulfill(route, { state: 'cancel_requested' })
  })
  await page.goto('/work/items/browser-task')
  await expect(page.getByText('累计取代 5 次', { exact: true })).toBeVisible()
  await expect(
    page.getByText('本步骤主动取代 2/5 次', { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText('继续需重新预览，或结束本 Run', { exact: true })
  ).toBeHidden()

  activeSupersedeCount = 5
  await page.reload()
  await expect(
    page.getByText('本步骤主动取代 5/5 次', { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText('继续需重新预览，或结束本 Run', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('link', { name: '重新预览' })).toHaveAttribute(
    'href',
    '/work'
  )
  await page.getByRole('button', { name: '结束本 Run', exact: true }).click()
  await expect.poll(() => canceled).toBe(true)
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

const artifactWorkspaceJson = (versionCount: number) => ({
  summary: {
    task_id: 'browser-task',
    title: '浏览器测试任务',
    task_state: 'awaiting_acceptance',
    display_state: 'awaiting_acceptance',
    permission_mode: 'ask_each',
    active_run_id: null,
    latest_run_id: null,
    latest_run: null,
    latest_artifact: {
      artifact_id: 'browser-artifact',
      version_no: versionCount,
      content_hash: 'artifact-hash',
    },
    revision: 4,
    pending_acceptance: true,
    blocking_operations: 0,
    quota: { reserved_tokens: 1000, settled_tokens: 0 },
    created_at: '2026-10-31T00:00:00Z',
    updated_at: '2026-10-31T00:00:00Z',
  },
  artifact: {
    artifact_id: 'browser-artifact',
    logical_name: 'result',
    state: 'published',
    revision: 0,
    created_at: '2026-10-31T00:00:00Z',
    updated_at: '2026-10-31T00:00:00Z',
    accepted_version_no: 1,
    versions: Array.from({ length: versionCount }, (_unused, index) => {
      const versionNo = versionCount - index
      return {
        version_no: versionNo,
        media_type: 'text/markdown',
        bytes: 42,
        content_hash: `artifact-hash-${versionNo}`,
        state: 'published',
        content_url: `/work/v1/tasks/browser-task/artifacts/browser-artifact/versions/${versionNo}/content`,
        created_at: '2026-10-31T00:00:00Z',
        published_at: '2026-10-31T00:00:00Z',
      }
    }),
  },
})

test('artifact editing survives a version conflict and publishes with the same idempotency key', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  let versionCount = 2
  const published: {
    client_request_id: string
    base_version_no: number
    content: string
  }[] = []

  await page.route(
    '**/work/v1/tasks/browser-task/artifacts/browser-artifact',
    (route) => fulfill(route, artifactWorkspaceJson(versionCount))
  )
  await page.route(
    '**/work/v1/artifacts/browser-artifact/versions',
    (route) => {
      const body = route.request().postDataJSON() as {
        client_request_id: string
        base_version_no: number
        content: string
      }
      published.push(body)
      if (published.length === 1)
        return fulfill(route, { code: 'version_conflict' }, 409)
      versionCount = 3
      return fulfill(
        route,
        {
          artifact_id: 'browser-artifact',
          version_no: 3,
          logical_name: 'result',
          media_type: 'text/markdown',
          bytes: 40,
          content_hash: 'artifact-hash-3',
          state: 'published',
          content_url:
            '/work/v1/tasks/browser-task/artifacts/browser-artifact/versions/3/content',
          created_at: '2026-10-31T02:00:00Z',
          published_at: '2026-10-31T02:00:00Z',
        },
        201
      )
    }
  )

  await page.goto('/work/items/browser-task/artifacts/browser-artifact')
  await expect(
    page.getByRole('heading', { name: 'Mock final artifact' })
  ).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: '编辑此版本' }).click()
  const editor = page.getByRole('textbox', { name: '成果正文' })
  await editor.fill('浏览器里改过的正文')
  await page.getByRole('button', { name: '保存为新版本' }).click()

  // D5:209 in a real browser: the refusal keeps the text and names both exits.
  await expect(page.getByText(/已有人先发布了更新的版本/)).toBeVisible()
  await expect(editor).toHaveValue('浏览器里改过的正文')
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(page.getByText(/已有人先发布了更新的版本/)).toBeHidden()
  await expect(editor).toHaveValue('浏览器里改过的正文')

  await page.getByRole('button', { name: '保存为新版本' }).click()
  await expect.poll(() => published.length).toBe(2)
  // The retry reuses the key, which is what stops a timed-out publish from becoming
  // two versions.
  expect(published[0].client_request_id).toBe(published[1].client_request_id)
  expect(published[1].base_version_no).toBe(2)
  expect(published[1].content).toBe('浏览器里改过的正文')

  await expect(page).toHaveURL(/version=3/)
  await expect(page.getByRole('button', { name: '编辑此版本' })).toBeVisible()
  expect(errors).toEqual([])
})

// D5 §13.10 asks for a new-versus-old route isolation check and §14 requires that an
// old task link never creates or maps a new task. The unit tests in
// legacyRedirect.test.ts pin the mapping; this drives it through the real router.
test('old /work links reach the read-only history view without a create surface', async ({
  page,
}) => {
  const errors = await mockBackend(page)

  await page.goto('/work?task=old-browser-task')
  await expect(page).toHaveURL(/\/work\/archive\?legacyTask=old-browser-task/)
  // The notice interpolates the task id, so this assertion does not depend on copy.
  await expect(page.getByText(/old-browser-task/)).toBeVisible()
  // Nothing on the history view may offer creation, and the composer must not mount.
  await expect(page.getByLabel('任务描述')).toHaveCount(0)

  await page.goto('/work?view=history')
  await expect(page).toHaveURL(/\/work\/archive$/)

  // The isolation half: the same parameter on a newer route is that route's own
  // query string, so /work/items must stay on the list.
  await page.goto('/work/items?view=all')
  await expect(page).toHaveURL(/\/work\/items\?view=all$/)

  expect(errors).toEqual([])
})

// device-design §3.3 in a real browser: a run that is handing its history back must read as
// "正在交回历史并收尾", and the same card must read as ordinary progress when the server says it is
// not. The v2 face is the only thing the two navigations differ by, which is the point - the run
// state stays `active` in both (control-design §4.2 forbids a run state for a hand-back), so the
// sentence is the only signal the owner gets.
const runningSummary = () => ({
  task_id: 'browser-task',
  title: '浏览器测试任务',
  task_state: 'open',
  display_state: 'running',
  permission_mode: 'ask_each',
  active_run_id: 'browser-run',
  latest_run_id: 'browser-run',
  latest_run: {
    id: 'browser-run',
    task_id: 'browser-task',
    attempt_no: 1,
    state: 'active',
    wait_reason: null,
    terminal_reason: null,
    control_revision: 0,
    runtime_version: 'r0b-exec-1',
    created_at: '2026-11-21T00:00:00Z',
    updated_at: '2026-11-21T00:00:00Z',
  },
  latest_artifact: null,
  revision: 2,
  pending_acceptance: false,
  blocking_operations: 0,
  quota: { reserved_tokens: 1000, settled_tokens: 0 },
  created_at: '2026-11-21T00:00:00Z',
  updated_at: '2026-11-21T00:00:00Z',
})

test('a run handing its history back says so on the card, and stops when the face stops', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  let handback = true
  const reads: string[] = []

  await page.route('**/work/v1/tasks?*', (route) =>
    fulfill(route, { items: [runningSummary()], next_cursor: null })
  )
  await page.route('**/work/v2/**', (route) => {
    reads.push(new URL(route.request().url()).pathname)
    return fulfill(route, {
      run_id: 'browser-run',
      history_handback: handback,
    })
  })

  await page.goto('/work/items?view=all')
  await expect.poll(() => reads.length, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('run-history-handback')).toHaveText(
    '正在交回历史并收尾'
  )
  // The card still shows the run's own state beside the sentence: an addition, not a replacement.
  await expect(page.getByText('浏览器测试任务')).toBeVisible()
  expect(reads).toEqual(['/work/v2/runs/browser-run/history-handback'])

  handback = false
  await page.reload()
  await expect.poll(() => reads.length, { timeout: 10_000 }).toBe(2)
  await expect(page.getByTestId('run-history-handback')).toHaveCount(0)
  await expect(page.getByText('浏览器测试任务')).toBeVisible()

  expect(errors).toEqual([])
})

test('R0b: a waiting operation shows its wait clock, J38 state and blocked outcomes', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  const task = snapshot('snapshot-r0b')
  task.summary.latest_run_id = 'browser-run'
  await page.route('**/work/v1/tasks/browser-task', (route) =>
    fulfill(route, task)
  )
  await page.route('**/work/v1/tasks/browser-task/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: event('snapshot-r0b'),
    })
  )
  await page.route('**/work/v2/runs/browser-run/reconciliations', (route) =>
    fulfill(route, {
      org_id: 'browser-org',
      run_id: 'browser-run',
      task_id: 'browser-task',
      run_state: 'active',
      wait_reason: 'reconcile',
      blocking: { new_run: true, acceptance: true },
      items: [
        {
          operation_id: 'browser-operation-tool',
          kind: 'tool',
          operation_state: 'unknown',
          reconcile_requested_at: '2026-11-22T10:00:00Z',
          waited_seconds: 42,
          resolution_state: 'pending',
          evidence_sources: ['receipt'],
          ticket_id: 'OPS-7',
          has_authoritative_evidence: false,
          contact_path: 'wait_for_reconciliation',
        },
      ],
    })
  )

  await page.goto('/work/items/browser-task')
  await expect(
    page.getByRole('heading', { name: '正在核账', exact: true })
  ).toBeVisible()
  await expect(page.getByText('已等待 42 秒', { exact: true })).toBeVisible()
  await expect(page.getByText('等待核账', { exact: true })).toBeVisible()
  await expect(
    page.getByText('在核账完成前不能新建运行。 · 在核账完成前不能采纳成果。', {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByText('证据来源：receipt', { exact: true })
  ).toBeVisible()
  await expect(page.getByText('工单 OPS-7', { exact: true })).toBeVisible()
  await expect(page.getByText('正在恢复', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('R0b: an active readonly grant can be revoked from the task page', async ({
  page,
}) => {
  const errors = await mockBackend(page)
  const task = snapshot('snapshot-grants')
  task.summary.latest_run_id = 'browser-run'
  await page.route('**/work/v1/tasks/browser-task', (route) =>
    fulfill(route, task)
  )
  await page.route('**/work/v1/tasks/browser-task/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: event('snapshot-grants'),
    })
  )

  let grantStatus = 'active'
  const revokes: { body: Record<string, unknown>; csrf?: string }[] = []
  await page.route('**/work/v2/readonly-grants**', (route) => {
    if (route.request().method() === 'POST') {
      revokes.push({
        body: route.request().postDataJSON() as Record<string, unknown>,
        csrf: route.request().headers()['x-csrf-token'],
      })
      grantStatus = 'revoked'
      return fulfill(route, {
        grant_id: 'browser-grant',
        status: 'revoked',
        revision: 3,
        replayed: false,
      })
    }
    return fulfill(route, {
      grants: [
        {
          id: 'browser-grant',
          owner_subject_id: 'browser-user',
          run_id: 'browser-run',
          device_id: 'browser-device',
          workspace_grant_id: 'browser-workspace-grant',
          grant_revision: 1,
          tool_set: ['workspace.read'],
          resource_selector_hash: 'a'.repeat(64),
          policy_epoch: 1,
          access_epoch: 1,
          approval_id: null,
          expires_at: '2026-11-23T12:00:00Z',
          status: grantStatus,
          consumed_count: 2,
          revision: 3,
          created_at: '2026-11-23T10:00:00Z',
          updated_at: '2026-11-23T10:00:00Z',
        },
      ],
    })
  })

  await page.goto('/work/items/browser-task')
  await expect(
    page.getByRole('heading', { name: '只读许可', exact: true })
  ).toBeVisible()
  await expect(page.getByText('workspace.read', { exact: true })).toBeVisible()
  await expect(page.getByText('有效', { exact: true })).toBeVisible()
  await expect(page.getByText('已使用 2 次', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.getByRole('button', { name: '确认撤销', exact: true }).click()
  await expect(page.getByText('已撤销该只读许可。')).toBeVisible()
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible()

  expect(revokes).toHaveLength(1)
  expect(revokes[0].csrf).toBe('mock-csrf')
  expect(revokes[0].body).toMatchObject({ expected_revision: 3 })
  expect(
    String(revokes[0].body.client_request_id ?? '').length
  ).toBeGreaterThanOrEqual(8)
  expect(errors).toEqual([])
})
