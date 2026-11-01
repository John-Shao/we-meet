import { expect, test, type Page, type Route } from '@playwright/test'

// Frontend-only browser checks: all backend responses below are mocked.
test.use({
  storageState: { cookies: [], origins: [] },
  // HONOR AMM-AN00 真机在 1200x2664 @520dpi 下的 CSS 视口宽度。
  viewport: { width: 369, height: 844 },
})

const fulfill = (route: Route, json: unknown, status = 200) =>
  route.fulfill({ status, json })

const seats = [
  {
    subject_id: '11661aed-ff06-4f14-a950-74f22ac4162e',
    role: 'owner',
    work_seat: false,
    status: 'active',
    revision: 1,
  },
  {
    subject_id: '535bbd27-0000-4000-8000-000000000001',
    role: 'member',
    work_seat: true,
    status: 'active',
    revision: 1,
  },
]

const overview = {
  org_id: 'browser-org',
  name: 'Mock browser organization',
  status: 'active',
  execution_enabled: true,
  seats: { total: 14, active: 2 },
  quota: {
    limit_tokens: 0,
    reserved_tokens: 0,
    settled_tokens: 0,
    enforcement: 'soft',
  },
  quota_period_id: '2026-11',
  run_cap_tokens: 100000,
  audit_retention_days: 365,
  org_revision: 2,
}

const mockAdmin = async (page: Page) => {
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
    if (path.endsWith('/bootstrap')) {
      return fulfill(route, {
        subject_id: 'browser-user',
        org: {
          id: 'browser-org',
          name: 'Mock browser organization',
          role: 'owner',
          work_seat: true,
        },
        permissions: [],
        phases: ['R0a'],
        execution_targets: [],
        allowed_permission_modes: ['ask_each'],
        limits: {
          max_goal_chars: 2000,
          max_background_chars: 4000,
          max_artifact_bytes: 262144,
          max_active_runs: 3,
        },
        csrf_token: 'mock-csrf',
      })
    }
    if (path.endsWith('/admin/overview')) return fulfill(route, overview)
    if (path.endsWith('/admin/usage')) {
      return fulfill(route, {
        from: '2026-10-25',
        to: '2026-11-01',
        note: '仅供参考',
        items: [
          {
            provider: 'aliyun',
            model: 'qwen3.8-flash',
            input_tokens: 107,
            output_tokens: 43,
            cached_input_tokens: 10,
            run_count: 3,
          },
        ],
      })
    }
    if (path.endsWith('/admin/provider-config')) {
      return fulfill(route, {
        config_id: 'cfg-1',
        revision: 2,
        provider: 'aliyun',
        model: 'qwen3.8-flash',
        region: 'cn-beijing',
        endpoint: 'https://dashscope.example.test/v1',
        credential_mode: 'managed_key',
        credential: {
          credential_id: 'cred-1',
          provider: 'aliyun',
          mode: 'managed_key',
          fingerprint: '9b3c03d25b217cc9',
          key_version: 2,
          state: 'active',
          created_at: '2026-10-31T00:00:00Z',
        },
        state: 'active',
        created_at: '2026-10-31T00:00:00Z',
      })
    }
    if (path.includes('/admin/seats')) {
      return fulfill(route, { items: seats, next_cursor: null })
    }
    return fulfill(route, { items: [], next_cursor: null })
  })
  return errors
}

test('admin seats table keeps its columns apart at a phone viewport', async ({
  page,
}) => {
  const errors = await mockAdmin(page)
  await page.goto('/admin/work')
  await expect(page.getByRole('heading', { name: '席位列表' })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '大模型接入配置' })
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: '用量统计' })).toBeVisible()
  await expect(page.getByText('9b3c03d25b217cc9')).toBeVisible()

  const cells = await page
    .locator('tbody tr')
    .first()
    .locator('td')
    .evaluateAll((tds) =>
      tds.map((td) => {
        const range = document.createRange()
        range.selectNodeContents(td)
        const box = range.getBoundingClientRect()
        return {
          text: (td.textContent || '').trim(),
          left: box.left,
          right: box.right,
        }
      })
    )

  expect(cells.map((cell) => cell.text)).toEqual([
    '11661aed-ff06-4f14-a950-74f22ac4162e',
    'owner',
    'active',
    '否',
  ])
  for (let index = 1; index < cells.length; index += 1) {
    expect(cells[index].left - cells[index - 1].right).toBeGreaterThanOrEqual(4)
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    )
  ).toBe(false)
  await expect(
    page.getByRole('button', { name: '创建导出', exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText('审计导出请在更宽的屏幕发起。', { exact: true })
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('audit export stays available, and the quota period is labelled, on a wide screen', async ({
  page,
}) => {
  const errors = await mockAdmin(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/admin/work')
  await expect(
    page.getByRole('button', { name: '创建导出', exact: true })
  ).toBeVisible()
  await expect(page.getByText('配额期间', { exact: true })).toBeVisible()
  await expect(page.getByText('2026-11', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
