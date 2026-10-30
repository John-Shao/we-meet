import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from './Composer'
import * as api from '../api/client'
import type {
  WorkBootstrap,
  WorkInputResponse,
  WorkPreviewResponse,
  WorkTemplate,
} from '../api/types'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('wouter', () => ({ useLocation: () => ['/work/new', navigate] }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  fetchWorkTemplates: vi.fn(),
  createWorkInput: vi.fn(),
  createWorkPreview: vi.fn(),
  submitWorkTask: vi.fn(),
}))

const bootstrap: WorkBootstrap = {
  subject_id: 'subject',
  org: { id: 'org', name: 'Test', role: 'member', work_seat: true },
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
  csrf_token: 'test',
}
const templates: WorkTemplate[] = ['summary', 'plan'].map((id) => ({
  id,
  name: id,
  description: `${id} description`,
  version: 1,
  sections: [],
  content_hash: id,
}))
const input: WorkInputResponse = {
  input_ref: 'input-original',
  content_hash: 'hash',
  bytes: 20,
  expires_at: '',
}
const preview: WorkPreviewResponse = {
  preview_hash: 'preview-original',
  expires_at: '',
  token_upper_bound: 1000,
  template: templates[0],
  input_ref: input.input_ref,
  input_hash: 'hash',
  input_bytes: 20,
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const clickPreview = () =>
  fireEvent.click(screen.getByRole('button', { name: 'composer.preview' }))
const edit = (field: string) => {
  if (field === 'goal' || field === 'background') {
    fireEvent.change(screen.getByLabelText(`composer.${field}`), {
      target: { value: `edited ${field}` },
    })
  } else {
    fireEvent.click(
      screen.getByRole('button', {
        name:
          field === 'template'
            ? /plan description/
            : /composer.mode.auto_readonly/,
      })
    )
  }
}
const setup = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <Composer bootstrap={bootstrap} />
      </QueryClientProvider>
    </StrictMode>
  )
  await screen.findByRole('button', { name: /plan description/ })
  fireEvent.change(screen.getByLabelText('composer.goal'), {
    target: { value: 'original goal' },
  })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.fetchWorkTemplates).mockResolvedValue({ items: templates })
  vi.mocked(api.createWorkInput).mockReset().mockResolvedValue(input)
  vi.mocked(api.createWorkPreview).mockReset().mockResolvedValue(preview)
  vi.mocked(api.submitWorkTask).mockReset().mockResolvedValue({
    task_id: 'created-task',
    run_id: 'run',
    revision: 1,
    task_state: 'open',
    display_state: 'queued',
    input_ref: input.input_ref,
  })
})

describe('Composer preview generations', () => {
  it('previews then submits exactly the confirmed intent', async () => {
    await setup()
    clickPreview()
    await screen.findByText('composer.confirmTitle')
    expect(api.submitWorkTask).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'composer.confirmSend' })
    )
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/work/items/created-task')
    )
    expect(api.submitWorkTask).toHaveBeenCalledWith(
      expect.objectContaining({
        input_ref: input.input_ref,
        template_id: 'summary',
        permission_mode: 'ask_each',
        preview_hash: preview.preview_hash,
      }),
      expect.anything()
    )
  })

  describe.each(['input', 'preview'] as const)('delayed %s', (stage) => {
    it.each(['goal', 'background', 'template', 'mode'])(
      'discards a late result after editing %s, then previews the new intent',
      async (field) => {
        const pendingInput = deferred<WorkInputResponse>()
        const pendingPreview = deferred<WorkPreviewResponse>()
        if (stage === 'input')
          vi.mocked(api.createWorkInput).mockReturnValueOnce(
            pendingInput.promise
          )
        else
          vi.mocked(api.createWorkPreview).mockReturnValueOnce(
            pendingPreview.promise
          )
        await setup()
        clickPreview()
        await waitFor(() =>
          expect(
            stage === 'input' ? api.createWorkInput : api.createWorkPreview
          ).toHaveBeenCalledTimes(1)
        )
        edit(field)
        await act(async () => {
          pendingInput.resolve(input)
          pendingPreview.resolve(preview)
        })
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: 'composer.preview' })
          ).toBeEnabled()
        )
        expect(
          screen.queryByText('composer.confirmTitle')
        ).not.toBeInTheDocument()
        if (stage === 'input')
          expect(api.createWorkPreview).not.toHaveBeenCalled()
        expect(api.submitWorkTask).not.toHaveBeenCalled()

        const nextInput = { ...input, input_ref: 'input-new' }
        vi.mocked(api.createWorkInput).mockResolvedValueOnce(nextInput)
        vi.mocked(api.createWorkPreview).mockResolvedValueOnce({
          ...preview,
          preview_hash: 'preview-new',
        })
        clickPreview()
        await screen.findByText('composer.confirmTitle')
        const inputChanged = field === 'goal' || field === 'background'
        const recreated = stage === 'input' || inputChanged
        expect(api.createWorkInput).toHaveBeenCalledTimes(recreated ? 2 : 1)
        expect(api.createWorkPreview).toHaveBeenLastCalledWith(
          {
            input_ref: recreated ? 'input-new' : input.input_ref,
            template_id: field === 'template' ? 'plan' : 'summary',
            permission_mode: field === 'mode' ? 'auto_readonly' : 'ask_each',
          },
          expect.anything()
        )
        if (inputChanged) {
          const calls = vi.mocked(api.createWorkInput).mock.calls
          expect(calls[1][0].client_request_id).not.toBe(
            calls[0][0].client_request_id
          )
          expect(calls[1][0][field as 'goal' | 'background']).toBe(
            `edited ${field}`
          )
        }
      }
    )
  })

  it.each(['goal', 'background', 'template', 'mode'])(
    'invalidates a displayed confirmation on %s edits',
    async (field) => {
      await setup()
      clickPreview()
      await screen.findByText('composer.confirmTitle')
      edit(field)
      expect(
        screen.queryByText('composer.confirmTitle')
      ).not.toBeInTheDocument()
      expect(api.submitWorkTask).not.toHaveBeenCalled()
    }
  )

  it('ignores stale preview errors after an edit', async () => {
    const pending = deferred<WorkPreviewResponse>()
    vi.mocked(api.createWorkPreview).mockReturnValueOnce(pending.promise)
    await setup()
    clickPreview()
    await waitFor(() => expect(api.createWorkPreview).toHaveBeenCalledTimes(1))
    edit('mode')
    await act(async () => {
      pending.reject(new Error('stale preview error'))
    })
    expect(screen.queryByText('stale preview error')).not.toBeInTheDocument()
  })

  it.each(['input', 'preview', 'submit'] as const)(
    'ignores late %s success after unmount',
    async (stage) => {
      const pendingInput = deferred<WorkInputResponse>()
      const pendingPreview = deferred<WorkPreviewResponse>()
      const pendingSubmit =
        deferred<Awaited<ReturnType<typeof api.submitWorkTask>>>()
      if (stage === 'input')
        vi.mocked(api.createWorkInput).mockReturnValueOnce(pendingInput.promise)
      if (stage === 'preview')
        vi.mocked(api.createWorkPreview).mockReturnValueOnce(
          pendingPreview.promise
        )
      if (stage === 'submit')
        vi.mocked(api.submitWorkTask).mockReturnValueOnce(pendingSubmit.promise)
      const { unmount } = await setup()
      clickPreview()
      if (stage !== 'input')
        await waitFor(() =>
          expect(api.createWorkPreview).toHaveBeenCalledTimes(1)
        )
      if (stage === 'submit') {
        await screen.findByText('composer.confirmTitle')
        fireEvent.click(
          screen.getByRole('button', { name: 'composer.confirmSend' })
        )
        await waitFor(() => expect(api.submitWorkTask).toHaveBeenCalledTimes(1))
      }
      unmount()
      await act(async () => {
        pendingInput.resolve(input)
        pendingPreview.resolve(preview)
        pendingSubmit.resolve({
          task_id: 'late',
          run_id: '',
          revision: 1,
          task_state: 'open',
          display_state: 'queued',
          input_ref: input.input_ref,
        })
      })
      if (stage === 'input')
        expect(api.createWorkPreview).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
    }
  )
})
