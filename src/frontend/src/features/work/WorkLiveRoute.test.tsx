import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkRoute } from './WorkRoute'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const stream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('renders the live route through React Query and the real client', async () => {
  vi.stubEnv('VITE_WORK_API_MODE', 'live')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/work/v1/bootstrap')) {
        return json({
          subject_id: 'u1',
          org: { id: 'o1', name: 'Acme', role: 'owner', work_seat: true },
          permissions: [],
          phases: ['R0a'],
          execution_targets: [],
          allowed_permission_modes: ['ask_each'],
          limits: {
            max_goal_chars: 2000,
            max_background_chars: 4000,
            max_artifact_bytes: 262144,
            max_active_runs: 1,
          },
          csrf_token: 'csrf',
        })
      }
      if (url.includes('/tasks/') && url.endsWith('/events')) return stream()
      if (url.includes('/work/v1/tasks?')) {
        return json({
          items: [
            {
              task_id: 't1',
              title: '真实任务',
              display_state: 'awaiting_acceptance',
              task_state: 'awaiting_acceptance',
              permission_mode: 'ask_each',
              active_run_id: null,
              latest_run_id: 'r1',
              latest_run: null,
              latest_artifact: {
                artifact_id: 'a1',
                version_no: 1,
                content_hash: 'sha256:x',
              },
              revision: 2,
              pending_acceptance: true,
              blocking_operations: 0,
              quota: { reserved_tokens: 0, settled_tokens: 120 },
              created_at: '2026-10-27T00:00:00Z',
              updated_at: '2026-10-27T00:00:00Z',
            },
          ],
          next_cursor: null,
        })
      }
      if (url.endsWith('/work/v1/inbox')) {
        return json({ items: [], next_cursor: null })
      }
      if (url.endsWith('/work/v1/admin/overview')) {
        return json({
          seats: { total: 4, active: 3 },
          quota: {
            enforcement: 'soft',
            limit_tokens: 10000,
            reserved_tokens: 0,
            settled_tokens: 120,
          },
          audit_retention_days: 365,
        })
      }
      if (url.includes('/work/v1/tasks/t1')) {
        return json({ summary: { task_id: 't1' }, goal: '真实目标' })
      }
      return json({})
    })
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <WorkRoute />
    </QueryClientProvider>
  )
  expect(await screen.findByText(/真实 API/)).toBeInTheDocument()
  expect((await screen.findAllByText('真实任务')).length).toBeGreaterThan(0)
})
