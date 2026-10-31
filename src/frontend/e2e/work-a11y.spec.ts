import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test, type Page, type Route } from '@playwright/test'

const axeSource = readFileSync(
  path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8'
)

type AxeResults = {
  violations: Array<{ id: string; impact: string | null; help: string }>
}

const scanMain = async (page: Page) =>
  page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: Element, options: object) => Promise<AxeResults>
        }
      }
    ).axe
    const main = document.querySelector('main')
    if (!main) {
      throw new Error('main landmark not found')
    }
    return axe.run(main, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    })
  })

const fulfill = (route: Route, json: unknown, status = 200) =>
  route.fulfill({ status, json })

const summary = {
  task_id: 'browser-task',
  title: '无障碍测试任务',
  display_state: 'awaiting_acceptance',
  task_state: 'awaiting_acceptance',
  permission_mode: 'ask_each',
  active_run_id: null,
  latest_run_id: null,
  latest_run: null,
  latest_artifact: {
    artifact_id: 'browser-artifact',
    version_no: 1,
    content_hash: 'sha256:browser-hash',
  },
  revision: 2,
  pending_acceptance: true,
  blocking_operations: 0,
  quota: { reserved_tokens: 0, settled_tokens: 0 },
  created_at: '2026-10-31T00:00:00Z',
  updated_at: '2026-10-31T00:00:00Z',
}

const mockBackend = async (page: Page) => {
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
    }
    if (path.endsWith('/templates')) {
      return fulfill(route, {
        items: [
          {
            id: 'summary',
            name: '摘要整理',
            description: 'mock template',
            version: 1,
            sections: [],
            content_hash: 'hash-summary',
          },
        ],
      })
    }
    if (path.endsWith('/tasks')) {
      return fulfill(route, { items: [], next_cursor: null })
    }
    if (path.endsWith('/artifacts/browser-artifact')) {
      return fulfill(route, {
        summary,
        artifact: {
          artifact_id: 'browser-artifact',
          logical_name: 'result',
          state: 'published',
          revision: 0,
          created_at: '2026-10-31T00:00:00Z',
          updated_at: '2026-10-31T00:00:00Z',
          accepted_version_no: 1,
          versions: [
            {
              version_no: 1,
              media_type: 'text/markdown',
              bytes: 32,
              content_hash: 'sha256:browser-hash',
              state: 'published',
              content_url:
                '/work/v1/tasks/browser-task/artifacts/browser-artifact/versions/1/content',
              created_at: '2026-10-31T00:00:00Z',
              published_at: '2026-10-31T00:00:00Z',
            },
          ],
        },
      })
    }
    if (path.endsWith('/content')) {
      return route.fulfill({
        contentType: 'text/markdown; charset=utf-8',
        body: '# 无障碍成果\n\n成果工作区正文。',
      })
    }
    return fulfill(route, { code: 'unmocked_endpoint' }, 404)
  })
}

test.use({ storageState: { cookies: [], origins: [] } })

test('work UI passes WCAG A/AA axe scan including color contrast', async ({
  page,
}) => {
  await mockBackend(page)

  const views = [
    {
      path: '/work',
      ready: page.getByRole('heading', {
        name: '让工作从一句话开始',
        exact: true,
      }),
    },
    {
      path: '/work/items?view=all',
      ready: page.getByRole('heading', { name: '我的工作', exact: true }),
    },
    {
      path: '/work/new',
      ready: page.getByLabel('任务描述', { exact: true }),
    },
    {
      path: '/work/items/browser-task/artifacts/browser-artifact?version=1',
      ready: page.getByRole('heading', { name: '无障碍成果', exact: true }),
    },
  ]

  for (const view of views) {
    await page.goto(view.path)
    await expect(view.ready).toBeVisible()
    await page.evaluate(axeSource)
    const results = await scanMain(page)
    expect(
      results.violations,
      `${view.path}: ${JSON.stringify(results.violations, null, 2)}`
    ).toEqual([])
  }
})
