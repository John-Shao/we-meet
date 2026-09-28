import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { RecordOverviewPanel } from './RecordOverviewPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const id = '11111111-1111-4111-8111-111111111111'
const job = {
  id,
  status: 'queued',
  attempt: 1,
  generation: 1,
  input_revision: 1,
  retryable: false,
  error_code: '',
  dispatch_pending: false,
  updated_at: '2026-09-22T00:00:00Z',
}
const version = {
  id: 'overview',
  created_at: '2026-09-22T00:00:00Z',
  is_current: true,
  asr_status: 'finished',
  content: { synopsis: 'Independent overview', topics: [] },
}
let client: QueryClient
let state: Record<string, unknown>
function show(onSourceAudio?: (ms: number) => void) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordOverviewPanel
        viewerId="owner"
        recordId="record"
        onSourceAudio={onSourceAudio}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  state = {
    revision: 1,
    available: true,
    can_generate: true,
    generation_ready: true,
    output_language: 'auto',
    job: null,
    version: null,
  }
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'PATCH') {
      expect(path).toBe('meeting-records/record/overview/')
      const payload = JSON.parse(String(options.body))
      expect(payload.expected_output_language).toBe(state.output_language)
      state = { ...state, output_language: payload.output_language }
      return { output_language: payload.output_language }
    }
    if (options?.method === 'POST') {
      expect(path).toBe('meeting-records/record/overview-requests/')
      state = { ...state, job }
      return { request_id: id, replayed: false, dispatch_state: 'sent', job }
    }
    expect(path).toBe('meeting-records/record/overview/')
    return state
  })
})

it('saves the shared generation language without generating or hiding existing content', async () => {
  const user = userEvent.setup()
  state = { ...state, version, job: { ...job, status: 'succeeded' } }
  const first = show()
  await user.click(
    await screen.findByRole('button', { name: 'recordOverview.more' })
  )
  await user.click(
    await screen.findByRole('menuitem', { name: 'recordOverview.language' })
  )
  const select = screen.getByRole('combobox', {
    name: 'recordOverview.language',
  })
  expect(select).toHaveValue('auto')
  await user.selectOptions(select, 'zh')
  await waitFor(() => expect(select).toHaveValue('zh'))
  expect(screen.getByText('Independent overview')).toBeVisible()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([, options]) => options?.method === 'POST')
  ).toBe(false)
  first.unmount()
  client.clear()
  show()
  await user.click(
    await screen.findByRole('button', { name: 'recordOverview.more' })
  )
  await user.click(
    await screen.findByRole('menuitem', { name: 'recordOverview.language' })
  )
  expect(
    screen.getByRole('combobox', { name: 'recordOverview.language' })
  ).toHaveValue('zh')
})

it('disables language changes while a generation is running', async () => {
  const user = userEvent.setup()
  state = { ...state, job }
  show()
  await user.click(
    await screen.findByRole('button', { name: 'recordOverview.more' })
  )
  await user.click(
    await screen.findByRole('menuitem', { name: 'recordOverview.language' })
  )
  expect(
    screen.getByRole('combobox', { name: 'recordOverview.language' })
  ).toBeDisabled()
})
afterEach(() => {
  client?.clear()
  vi.clearAllMocks()
  sessionStorage.clear()
})

it('generates only on explicit action and renders its separate result', async () => {
  show()
  const generate = await screen.findByRole('button', {
    name: 'recordOverview.generate',
  })
  await waitFor(() => expect(generate).toBeEnabled())
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([, options]) => options?.method === 'POST')
  ).toBe(false)
  fireEvent.click(generate)
  expect(
    await screen.findByRole('button', { name: 'recordOverview.generating' })
  ).toBeDisabled()
  state = { ...state, job: { ...job, status: 'succeeded' }, version }
  await act(async () => {
    await client.invalidateQueries()
  })
  await screen.findByText('Independent overview')
  expect(
    vi.mocked(fetchApi).mock.calls.every(([path]) => !path.includes('summary-'))
  ).toBe(true)
})

it('preserves the idempotency key after an uncertain response and a remount', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  let fail = true
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'POST' && fail) throw new TypeError('network lost')
    return baseline(path, options, ...rest)
  })
  const first = show()
  const generate = await screen.findByRole('button', {
    name: 'recordOverview.generate',
  })
  await waitFor(() => expect(generate).toBeEnabled())
  fireEvent.click(generate)
  await screen.findByText('recordOverview.uncertain')
  first.unmount()
  client.clear()
  fail = false
  show()
  const recover = await screen.findByRole('button', {
    name: 'recordOverview.generate',
  })
  await waitFor(() => expect(recover).toBeEnabled())
  fireEvent.click(recover)
  await screen.findByText('recordOverview.accepted')
  const posts = vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[0][1]?.headers).toEqual(posts[1][1]?.headers)
  expect(posts[0][1]?.body).toEqual(posts[1][1]?.body)
})

it('keeps the previous overview and chapters visible after failure and retries through one action', async () => {
  state = {
    ...state,
    job: { ...job, status: 'failed', retryable: true },
    version: { ...version, content: { ...version.content, topics } },
  }
  show()
  await screen.findByText('Independent overview')
  expect(screen.getByText('Chapter details')).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent(
    'recordOverview.failedPreserved'
  )
  expect(
    screen.queryByRole('button', { name: 'recordOverview.retry' })
  ).toBeNull()
  const retry = screen.getByRole('button', {
    name: 'recordOverview.regenerate',
  })
  await waitFor(() => expect(retry).toBeEnabled())
  fireEvent.click(retry)
  await screen.findByText('recordOverview.accepted')
  const body = vi
    .mocked(fetchApi)
    .mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body
  expect(JSON.parse(String(body))).toMatchObject({
    operation: 'retry',
    expected_job_id: id,
    expected_attempt: 1,
  })
})

it.each([
  { status: 'failed', retryable: true, revision: 1, operation: 'retry' },
  { status: 'failed', retryable: true, revision: 2, operation: 'regenerate' },
  { status: 'failed', retryable: false, revision: 1, operation: 'regenerate' },
  {
    status: 'canceled',
    retryable: false,
    revision: 1,
    operation: 'regenerate',
  },
])(
  'offers generate without an overview after $status (revision $revision, retryable $retryable)',
  async ({ status, retryable, revision, operation }) => {
    state = { ...state, revision, job: { ...job, status, retryable } }
    show()
    const generate = await screen.findByRole('button', {
      name: 'recordOverview.generate',
    })
    await waitFor(() => expect(generate).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('recordOverview.failed')
    expect(
      screen.queryByRole('button', { name: 'recordOverview.regenerate' })
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'recordOverview.retry' })
    ).toBeNull()
    fireEvent.click(generate)
    await waitFor(() =>
      expect(
        vi
          .mocked(fetchApi)
          .mock.calls.some(([, options]) => options?.method === 'POST')
      ).toBe(true)
    )
    const body = vi
      .mocked(fetchApi)
      .mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body
    expect(JSON.parse(String(body))).toMatchObject({
      operation,
      expected_revision: revision,
    })
  }
)

it('starts a new generation when an overview already exists', async () => {
  state = { ...state, job: { ...job, status: 'succeeded' }, version }
  show()
  const regenerate = await screen.findByRole('button', {
    name: 'recordOverview.regenerate',
  })
  await waitFor(() => expect(regenerate).toBeEnabled())
  fireEvent.click(regenerate)
  await screen.findByText('recordOverview.accepted')
  const body = vi
    .mocked(fetchApi)
    .mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body
  expect(JSON.parse(String(body))).toMatchObject({ operation: 'regenerate' })
})

it.each(['queued', 'running'])(
  'disables generation while $status and retains the existing overview',
  async (status) => {
    state = { ...state, job: { ...job, status }, version }
    show()
    expect(
      await screen.findByRole('button', { name: 'recordOverview.generating' })
    ).toBeDisabled()
    expect(screen.getByText('Independent overview')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'recordOverview.regenerate' })
    ).toBeNull()
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(([, options]) => options?.method === 'POST')
    ).toBe(false)
  }
)

it('summary readers cannot generate and stale data disappears on a refused refresh', async () => {
  state = { ...state, can_generate: false, version }
  show()
  await screen.findByText('Independent overview')
  expect(
    screen.queryByRole('button', { name: 'recordOverview.generate' })
  ).toBeNull()
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(403, {}))
  await act(async () => {
    await client.invalidateQueries()
  })
  await screen.findByText('library.loadError')
  expect(screen.queryByText('Independent overview')).toBeNull()
})

const topics = [
  {
    title: 'First chapter',
    text: 'Chapter details',
    source_refs: [5000, 1000, 3000].map((ms) => ({
      segment_id: `source-${ms}`,
      segment_revision: 1,
      start_ms: ms,
      end_ms: ms + 1000,
    })),
  },
]

it('shows the synopsis and chapters together under one generation action', async () => {
  state = {
    ...state,
    version: { ...version, content: { ...version.content, topics } },
  }
  show(vi.fn())
  await screen.findByText(version.content.synopsis)
  expect(screen.getByText('First chapter')).toBeVisible()
  expect(screen.getByText('Chapter details')).toBeVisible()
  expect(
    screen.getAllByRole('button', { name: 'recordOverview.regenerate' })
  ).toHaveLength(1)
  expect(
    screen.getByRole('heading', { name: 'recordOverview.synopsisTitle' })
  ).toBeVisible()
  expect(
    screen.getByRole('heading', { name: 'recordAi.sections.chapters' })
  ).toBeVisible()
  expect(screen.getByText('recordOverview.hint')).toBeVisible()
})

it('regenerates both sections with one request and preserves both until publication', async () => {
  state = {
    ...state,
    job: { ...job, status: 'succeeded' },
    version: { ...version, content: { ...version.content, topics } },
  }
  show()
  const regenerate = await screen.findByRole('button', {
    name: 'recordOverview.regenerate',
  })
  await waitFor(() => expect(regenerate).toBeEnabled())
  fireEvent.click(regenerate)
  await screen.findByRole('button', { name: 'recordOverview.generating' })
  expect(screen.getByText('Independent overview')).toBeVisible()
  expect(screen.getByText('Chapter details')).toBeVisible()
  const posts = vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0][1]?.body)).operation).toBe('regenerate')
  state = {
    ...state,
    job: { ...job, status: 'succeeded' },
    version: {
      ...version,
      id: 'new-overview',
      content: {
        synopsis: 'Updated overview',
        topics: [{ ...topics[0], text: 'Updated chapter details' }],
      },
    },
  }
  await act(async () => {
    await client.invalidateQueries()
  })
  await screen.findByText('Updated overview')
  expect(screen.getByText('Updated chapter details')).toBeVisible()
  expect(screen.queryByText('Independent overview')).not.toBeInTheDocument()
  expect(screen.queryByText('Chapter details')).not.toBeInTheDocument()
})

it('expands chapter references alongside the synopsis without changing playback times', async () => {
  state = {
    ...state,
    version: { ...version, content: { ...version.content, topics } },
  }
  const seek = vi.fn()
  show(seek)
  await screen.findByText('Chapter details')
  expect(screen.getByText(version.content.synopsis)).toBeVisible()
  expect(screen.getByText('recordOverview.hint')).toBeVisible()
  expect(screen.getByText('recordAi.listenSource 0:03')).not.toBeVisible()
  fireEvent.click(
    screen.getByRole('button', { name: 'recordAi.listenSource 0:01' })
  )
  expect(seek).toHaveBeenLastCalledWith(1000)
  await userEvent.click(screen.getByText('recordOverview.moreSources'))
  expect(
    screen.getAllByRole('button', { name: /recordAi.listenSource/ })
  ).toHaveLength(3)
  fireEvent.click(
    screen.getByRole('button', { name: 'recordAi.listenSource 0:03' })
  )
  expect(seek).toHaveBeenLastCalledWith(3000)
  await userEvent.click(screen.getByText('recordOverview.moreSources'))
  expect(screen.getByText('recordAi.listenSource 0:03')).not.toBeVisible()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([, options]) => options?.method === 'POST')
  ).toBe(false)
})

it('keeps chapter text without playback permission and handles an empty chapter list', async () => {
  state = {
    ...state,
    version: { ...version, content: { ...version.content, topics } },
  }
  show()
  await screen.findByText('Chapter details')
  expect(screen.queryByText('recordOverview.moreSources')).toBeNull()
  state = { ...state, version }
  await act(async () => {
    await client.invalidateQueries()
  })
  await screen.findByText('recordOverview.chaptersEmpty')
  expect(screen.getByText(version.content.synopsis)).toBeVisible()
})
