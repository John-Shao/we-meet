import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SummaryTaskActions } from './SummaryTaskActions'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
let state: {
  review_id: string
  can_convert: boolean
  assignees: { id: string; name: string }[]
  actions: ({
    task_id: string | null
    status: string | null
    deleted: boolean
  } | null)[]
}
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SummaryTaskActions
        recordId="record"
        viewerId="user"
        reviewId="review"
        actions={[
          {
            text: 'Follow up',
            owner_text: 'Guessed owner',
            due_text: 'Tomorrow maybe',
            source_refs: [],
          },
        ]}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  state = {
    review_id: 'review',
    can_convert: true,
    assignees: [{ id: 'member', name: 'Selected member' }],
    actions: [null],
  }
  mocks.fetchApi.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      state = {
        ...state,
        actions: [{ task_id: 'task', status: 'todo', deleted: false }],
      }
      return { created: true }
    }
    return state
  })
})
afterEach(() => client?.clear())

it('requires an explicit assignee and does not infer the date from prose', async () => {
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryTasks.convert' })
  )
  expect(
    screen.getByRole('button', { name: 'summaryTasks.confirm' })
  ).toBeDisabled()
  expect(posts()).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('summaryTasks.assignee'), {
    target: { value: 'member' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'summaryTasks.confirm' }))
  await screen.findByText('summaryTasks.created')
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({
    review_id: 'review',
    action_index: 0,
    title: 'Follow up',
    assignee_id: 'member',
    due_date: null,
  })
  expect(
    await screen.findByRole('link', { name: 'summaryTasks.open' })
  ).toHaveAttribute('href', '/tasks?task=task')
})

it('retries the same frozen request after a lost response', async () => {
  const fallback = mocks.fetchApi.getMockImplementation()!
  let failed = false
  mocks.fetchApi.mockImplementation((url, options) => {
    if (options?.method === 'POST' && !failed) {
      failed = true
      return Promise.reject(new TypeError('lost response'))
    }
    return fallback(url, options)
  })
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryTasks.convert' })
  )
  fireEvent.change(screen.getByLabelText('summaryTasks.assignee'), {
    target: { value: 'member' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'summaryTasks.confirm' }))
  await screen.findByText('summaryTasks.uncertain')
  expect(screen.getByLabelText('summaryTasks.taskTitle')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'summaryTasks.retry' }))
  await screen.findByText('summaryTasks.created')
  expect(posts()[0][1].body).toBe(posts()[1][1].body)
})

it('keeps a deleted-task receipt and never offers implicit recreation', async () => {
  state.actions = [{ task_id: null, status: null, deleted: true }]
  show()
  await screen.findByText('summaryTasks.deleted')
  expect(
    screen.queryByRole('button', { name: 'summaryTasks.convert' })
  ).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

it('does not apply actions to a different current revision', async () => {
  state.review_id = 'newer-review'
  show()
  await screen.findByText('summaryTasks.conflict')
  expect(
    screen.queryByRole('button', { name: 'summaryTasks.convert' })
  ).not.toBeInTheDocument()
  expect(posts()).toHaveLength(0)
})
