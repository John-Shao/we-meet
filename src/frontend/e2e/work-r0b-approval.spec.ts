import { expect, test } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test('task page opens pending approval metadata only through the secure bridge', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'zh')
    const opened: unknown[] = []
    Object.assign(window, {
      __approvalOpened: opened,
      weMeetDesktop: {
        isDesktop: false,
        platform: 'web',
        getStatus: async () => ({
          connection: 'online',
          auth: 'signed-in',
          message: '',
        }),
        onStatus: () => () => {},
        work: {
          listPendingLocalApprovals: async () => ({
            status: 'available',
            approvals: [
              {
                approvalId: '33333333-3333-4333-8333-333333333333',
                taskId: 'browser-task',
                runId: '55555555-5555-4555-8555-555555555555',
                operationId: '44444444-4444-4444-8444-444444444444',
                actionKind: 'artifact.write',
                risk: 'local_write',
                expiresAt: '2027-01-01T00:00:00Z',
              },
            ],
          }),
          openLocalContent: async (...args: unknown[]) => {
            opened.push(args)
            return { status: 'opened' }
          },
          onApprovalDecided: () => () => {},
        },
      },
    })
  })
  await page.route('**/api/v1.0/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/config/')) {
      return route.fulfill({
        json: {
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
        },
      })
    }
    if (path.includes('/users/me')) {
      return route.fulfill({
        json: {
          id: 'browser-user',
          email: 'browser@example.test',
          full_name: 'Browser Test',
          last_name: 'Test',
          language: 'zh',
          timezone: 'Asia/Shanghai',
        },
      })
    }
    return route.fulfill({ json: { results: [], count: 0, items: [] } })
  })
  await page.route('**/work/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/bootstrap')) {
      return route.fulfill({
        json: {
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
          allowed_permission_modes: ['ask_each'],
          limits: {
            max_goal_chars: 2000,
            max_background_chars: 4000,
            max_artifact_bytes: 262144,
            max_active_runs: 3,
          },
          csrf_token: 'mock-csrf',
        },
      })
    }
    if (path.endsWith('/tasks/browser-task')) {
      return route.fulfill({
        json: {
          summary: {
            task_id: 'browser-task',
            title: '审批浏览器测试',
            display_state: 'running',
            task_state: 'open',
            permission_mode: 'ask_each',
            active_run_id: null,
            latest_run_id: null,
            latest_run: null,
            latest_artifact: null,
            revision: 1,
            pending_acceptance: false,
            blocking_operations: 0,
            quota: { reserved_tokens: 0, settled_tokens: 0 },
            created_at: '2026-10-31T00:00:00Z',
            updated_at: '2026-10-31T00:00:00Z',
          },
          input_ref: 'input',
          goal: 'test',
          background: null,
          template: null,
          snapshot: null,
          latest_event_id: 'cursor',
        },
      })
    }
    if (path.endsWith('/inbox')) {
      return route.fulfill({ json: { items: [], next_cursor: null } })
    }
    if (path.endsWith('/tasks')) {
      return route.fulfill({ json: { items: [], next_cursor: null } })
    }
    if (path.includes('/events')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      })
    }
    return route.fulfill({ status: 404, json: { code: 'unmocked_endpoint' } })
  })

  await page.goto('/work/items/browser-task')
  await expect(
    page.getByRole('heading', { name: '待审批', exact: true })
  ).toBeVisible()
  await expect(page.getByText('artifact.write')).toBeVisible()
  await expect(page.getByText('local_write')).toBeVisible()
  await page.getByRole('button', { name: '安全查看', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __approvalOpened: unknown[]
            }
          ).__approvalOpened
      )
    )
    .toEqual([['approval', '33333333-3333-4333-8333-333333333333']])
})
