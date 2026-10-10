import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import type { ApiMeetingRecord } from '@/features/meetings/api/ApiMeetingRecord'
import {
  clearIdentityIntents,
  identityIntent,
  rememberIdentityIntent,
} from './identificationIntent'
import { SpeakerIdentificationPanel } from './SpeakerIdentificationPanel'
import { IdentificationClient } from './identificationApi'
import {
  OWNER,
  RECORD,
  SPEAKER,
  ORG,
  KEY,
  SUGGESTION,
  options,
  response,
  submission,
} from './identificationFixtures.test-utils'

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  candidates: vi.fn(),
  read: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  decide: vi.fn(),
  config: {
    data: { speaker_identity: { enabled: true, matching_enabled: true } },
  },
}))
vi.mock('@/api/useConfig', () => ({ useConfig: () => mocks.config }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      `${key}${values?.name ? ':' + values.name : values?.number ? ':' + values.number : ''}`,
  }),
}))
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
    ...props
  }: {
    children: React.ReactNode
    onPress?: () => void
    isDisabled?: boolean
  }) => (
    <button {...props} disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

let cache: QueryClient
let preview: ReturnType<typeof vi.fn>, stopPreview: ReturnType<typeof vi.fn>
const record: ApiMeetingRecord = {
  id: RECORD,
  source_type: 'upload',
  source_session_id: null,
  meeting_session_id: null,
  title: 'Synthetic',
  revision: 1,
  origin_at: '2026-10-10T00:00:00Z',
  retention_mode: 'media',
  source_available: true,
  upload: {
    status: 'succeeded',
    name: 'synthetic.wav',
    size: 1000,
    media_type: 'audio',
  },
  capabilities: {
    read_summary: true,
    read_transcript: true,
    play_media: true,
    download_media: true,
    edit: true,
    rename: true,
    manage: false,
    capture: false,
    generate_summary: false,
  },
}
const workspaceKey = ['record-library-content', OWNER, 1, 'originals']
function show(overrides: Partial<ApiMeetingRecord> = {}, strict = false) {
  const panel = (
    <QueryClientProvider client={cache}>
      <SpeakerIdentificationPanel
        record={{ ...record, ...overrides }}
        viewerId={OWNER}
        onPreview={preview}
        onPreviewStop={stopPreview}
      />
    </QueryClientProvider>
  )
  return render(strict ? <StrictMode>{panel}</StrictMode> : panel)
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  return screen.findByRole('checkbox', { name: 'Ada' })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(IdentificationClient.prototype, 'options').mockImplementation(
    mocks.options
  )
  vi.spyOn(IdentificationClient.prototype, 'candidates').mockImplementation(
    mocks.candidates
  )
  vi.spyOn(IdentificationClient.prototype, 'read').mockImplementation(
    mocks.read
  )
  vi.spyOn(IdentificationClient.prototype, 'submit').mockImplementation(
    mocks.submit
  )
  vi.spyOn(IdentificationClient.prototype, 'cancel').mockImplementation(
    mocks.cancel
  )
  vi.spyOn(IdentificationClient.prototype, 'decide').mockImplementation(
    mocks.decide
  )
  clearIdentityIntents()
  setTokens({ accessToken: 'original-login' })
  mocks.config.data.speaker_identity.matching_enabled = true
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cache.setQueryData(workspaceKey, { results: [] })
  preview = vi.fn().mockResolvedValue(true)
  stopPreview = vi.fn()
  mocks.options.mockImplementation(async (revision: number) => ({
    ...options(),
    record_revision: revision,
  }))
  mocks.read.mockResolvedValue({ record_revision: 1, request: null })
  mocks.candidates.mockImplementation(
    async (scope: string | null, revision: number) => ({
      record_revision: revision,
      organization_id: scope,
      results: [{ id: OWNER, name: 'Ada' }],
      next_offset: null,
    })
  )
  mocks.submit.mockImplementation(async (input) => {
    const value = response(true)
    value.request!.request_key = input.request_key
    return value
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  cache.clear()
  clearIdentityIntents()
  vi.useRealTimers()
})

it('does not read or submit before opening, including StrictMode initialization', async () => {
  show({}, true)
  expect(mocks.read).not.toHaveBeenCalled()
  expect(mocks.submit).not.toHaveBeenCalled()
  const person = await open()
  expect(screen.getByRole('combobox', { name: 'scope' })).toBeVisible()
  expect(person).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled()
  expect(mocks.submit).not.toHaveBeenCalled()
})

it('hides identification from read-only, media-less and rollout-disabled views', () => {
  const view = show({ capabilities: { ...record.capabilities, edit: false } })
  expect(screen.queryByRole('button', { name: 'open' })).not.toBeInTheDocument()
  view.rerender(
    <QueryClientProvider client={cache}>
      <SpeakerIdentificationPanel
        record={{
          ...record,
          capabilities: { ...record.capabilities, play_media: false },
        }}
        viewerId={OWNER}
        onPreview={preview}
        onPreviewStop={stopPreview}
      />
    </QueryClientProvider>
  )
  expect(screen.queryByRole('button', { name: 'open' })).not.toBeInTheDocument()
  mocks.config.data.speaker_identity.matching_enabled = false
  view.rerender(
    <QueryClientProvider client={cache}>
      <SpeakerIdentificationPanel
        record={record}
        viewerId={OWNER}
        onPreview={preview}
        onPreviewStop={stopPreview}
      />
    </QueryClientProvider>
  )
  expect(screen.queryByRole('button', { name: 'open' })).not.toBeInTheDocument()
  expect(mocks.read).not.toHaveBeenCalled()
})

it('sends only explicitly chosen people and tracks and does not resubmit processing work', async () => {
  show()
  fireEvent.click(await open())
  fireEvent.click(screen.getByRole('button', { name: 'submit' }))
  await screen.findByText('status.queued')
  expect(mocks.submit).toHaveBeenCalledOnce()
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({
    expected_revision: 1,
    organization_id: null,
    user_ids: [OWNER],
    speaker_ids: [SPEAKER],
  })
  expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled()
  expect(
    screen.queryByRole('button', { name: 'confirm' })
  ).not.toBeInTheDocument()
})

it('listens to the verified source window then confirms and refreshes reader projections', async () => {
  const completed = response()
  completed.record_revision = 2
  const row = completed.request!.jobs[0].suggestion!
  row.state = 'confirmed'
  row.candidate = null
  row.can_confirm = false
  row.query_intervals = []
  mocks.read.mockResolvedValueOnce(response()).mockResolvedValue(completed)
  mocks.options.mockImplementation(async (revision: number) => ({
    ...options(),
    record_revision: revision,
    targets: revision === 2 ? [] : options().targets,
  }))
  mocks.decide.mockResolvedValue({
    id: SPEAKER,
    display_name: 'Ada',
    record_revision: 2,
  })
  show()
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'preview:1' }))
  await waitFor(() => expect(preview).toHaveBeenCalledWith(100, 4000))
  fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
  await screen.findByText('decision.confirmed')
  expect(mocks.decide.mock.calls[0].slice(0, 4)).toEqual([
    SPEAKER,
    SUGGESTION,
    'confirm_suggestion',
    1,
  ])
  expect(cache.getQueryState(workspaceKey)?.isInvalidated).toBe(true)
  expect(screen.queryByText('suggested:Ada')).not.toBeInTheDocument()
  expect(stopPreview).toHaveBeenCalled()
})

it('hides stale names after a conflict and its Refresh uses the current server revision', async () => {
  mocks.read
    .mockResolvedValueOnce(response())
    .mockResolvedValue({ record_revision: 2, request: null })
  mocks.decide.mockRejectedValue(
    new ApiError(409, { code: 'voiceprint_suggestion_changed' })
  )
  show()
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
  await screen.findByText('conflict')
  expect(screen.queryByText('suggested:Ada')).not.toBeInTheDocument()
  expect(mocks.decide).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(mocks.options.mock.calls.at(-1)![0]).toBe(2))
  await waitFor(() =>
    expect(screen.queryByText('conflict')).not.toBeInTheDocument()
  )
})

it('keeps an uncertain exact request when the panel closes and reopens', async () => {
  mocks.submit.mockRejectedValue(new Error('connection lost'))
  mocks.read.mockImplementation(async (key?: string) => {
    if (key)
      throw new ApiError(404, {
        code: 'voiceprint_identity_request_unavailable',
      })
    return { record_revision: 1, request: null }
  })
  show()
  fireEvent.click(await open())
  fireEvent.click(screen.getByRole('button', { name: 'submit' }))
  await screen.findByRole('button', { name: 'retrySame' })
  const command = mocks.submit.mock.calls[0][0]
  fireEvent.click(screen.getByRole('button', { name: 'close' }))
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  const retry = await screen.findByRole('button', { name: 'retrySame' })
  await waitFor(() => expect(retry).not.toBeDisabled())
  fireEvent.click(retry)
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
  expect(mocks.submit.mock.calls[1][0]).toEqual(command)
})

it("recovers another panel's uncertain command without sending or reading a new request key", async () => {
  const client = new IdentificationClient(RECORD, OWNER)
  show()
  fireEvent.click(await open())
  rememberIdentityIntent(client, submission())
  mocks.read.mockImplementation(async (key?: string) => {
    if (key === KEY)
      throw new ApiError(404, {
        code: 'voiceprint_identity_request_unavailable',
      })
    return { record_revision: 1, request: null }
  })
  fireEvent.click(screen.getByRole('button', { name: 'submit' }))
  await screen.findByRole('button', { name: 'retrySame' })
  expect(mocks.submit).not.toHaveBeenCalled()
  expect(identityIntent(client)).toEqual(submission())
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(mocks.read.mock.calls.at(-1)![0]).toBe(KEY))
  const retry = screen.getByRole('button', { name: 'retrySame' })
  await waitFor(() => expect(retry).not.toBeDisabled())
  fireEvent.click(retry)
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce())
  expect(mocks.submit.mock.calls[0][0]).toEqual(submission())
})

it('stops showing private data and closes the panel after a login change', async () => {
  mocks.read.mockResolvedValue(response())
  show()
  await open()
  expect(screen.getByText('suggested:Ada')).toBeInTheDocument()
  setTokens({ accessToken: 'other-login' })
  await waitFor(() =>
    expect(screen.queryByText('suggested:Ada')).not.toBeInTheDocument()
  )
  expect(screen.getByRole('button', { name: 'open' })).toBeInTheDocument()
  expect(stopPreview).toHaveBeenCalled()
  expect(mocks.decide).not.toHaveBeenCalled()
})

it('does not carry people across libraries or accept a late previous-scope response', async () => {
  let complete!: (value: unknown) => void
  mocks.candidates.mockImplementation((scope: string | null) =>
    scope === null
      ? new Promise((resolve) => {
          complete = resolve
        })
      : Promise.resolve({
          record_revision: 1,
          organization_id: ORG,
          results: [{ id: ORG, name: 'Bob' }],
          next_offset: null,
        })
  )
  show()
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  const chooser = await screen.findByLabelText('scope')
  await waitFor(() => expect(mocks.candidates).toHaveBeenCalledOnce())
  fireEvent.change(chooser, { target: { value: ORG } })
  await screen.findByRole('checkbox', { name: 'Bob' })
  act(() =>
    complete({
      record_revision: 1,
      organization_id: null,
      results: [{ id: OWNER, name: 'Private late name' }],
      next_offset: null,
    })
  )
  await act(async () => {})
  expect(screen.queryByText('Private late name')).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Bob' })).not.toBeChecked()
})

it('permits rejection without a verifiable candidate while keeping confirmation disabled', async () => {
  const unavailable = response()
  const suggestion = unavailable.request!.jobs[0].suggestion!
  suggestion.candidate = null
  suggestion.can_confirm = false
  suggestion.query_intervals = []
  suggestion.verification_unavailable = true
  mocks.read.mockResolvedValue(unavailable)
  mocks.decide.mockResolvedValue({
    id: SPEAKER,
    display_name: 'Speaker 0',
    record_revision: 2,
  })
  show()
  await open()
  expect(screen.getByRole('button', { name: 'confirm' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'reject' }))
  await waitFor(() =>
    expect(mocks.decide.mock.calls[0].slice(0, 4)).toEqual([
      SPEAKER,
      SUGGESTION,
      'reject_suggestion',
      1,
    ])
  )
})

it('cancels the known request while matching reads are temporarily unavailable', async () => {
  mocks.read
    .mockResolvedValueOnce(response())
    .mockRejectedValue(new ApiError(503, {}))
  const canceled = response()
  canceled.request!.jobs[0].status = 'canceled'
  const suggestion = canceled.request!.jobs[0].suggestion!
  suggestion.state = 'invalidated'
  suggestion.candidate = null
  suggestion.can_confirm = false
  suggestion.query_intervals = []
  mocks.cancel.mockResolvedValue(canceled)
  show()
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await screen.findByText('requestError')
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
  await waitFor(() =>
    expect(mocks.cancel.mock.calls[0].slice(0, 2)).toEqual([KEY, 1])
  )
  expect(mocks.submit).not.toHaveBeenCalled()
})

it('polls a completed pending suggestion and removes its name when it is invalidated', async () => {
  vi.useFakeTimers()
  const invalidated = response()
  invalidated.request!.jobs[0].status = 'canceled'
  const suggestion = invalidated.request!.jobs[0].suggestion!
  suggestion.state = 'invalidated'
  suggestion.candidate = null
  suggestion.can_confirm = false
  suggestion.query_intervals = []
  mocks.read.mockResolvedValueOnce(response()).mockResolvedValue(invalidated)
  show()
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  await vi.waitFor(() =>
    expect(screen.getByText('suggested:Ada')).toBeInTheDocument()
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5001)
  })
  expect(mocks.read).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('suggested:Ada')).not.toBeInTheDocument()
  expect(screen.getByText('decision.invalidated')).toBeInTheDocument()
  expect(mocks.submit).not.toHaveBeenCalled()
})

it('keeps both human decisions disabled until the whole batch finishes', async () => {
  const value = response()
  value.request!.processing = true
  value.request!.jobs[0].suggestion!.can_confirm = false
  value.request!.jobs.push({
    ...response(true).request!.jobs[0],
    id: ORG,
    speaker_id: ORG,
  })
  mocks.read.mockResolvedValue(value)
  show()
  await open()
  expect(screen.getByRole('button', { name: 'confirm' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'reject' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'cancel' })).not.toBeDisabled()
})

it('preserves explicit choices across pages and caps the candidate pool at fifty', async () => {
  mocks.options.mockResolvedValue({
    ...options(),
    required_organization_id: ORG,
    personal_allowed: false,
  })
  mocks.candidates.mockImplementation(
    async (_scope, _revision, _query, offset: number) => ({
      record_revision: 1,
      organization_id: ORG,
      next_offset: offset < 50 ? offset + 25 : null,
      results: Array.from({ length: offset < 50 ? 25 : 1 }, (_, i) => ({
        id: `99999999-9999-4999-8999-${String(offset + i + 100).padStart(12, '0')}`,
        name: `Person ${offset + i}`,
      })),
    })
  )
  show()
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  await screen.findByRole('checkbox', { name: 'Person 0' })
  for (let i = 0; i < 25; i++)
    fireEvent.click(screen.getByRole('checkbox', { name: `Person ${i}` }))
  fireEvent.click(screen.getByRole('button', { name: 'moreCandidates' }))
  await screen.findByRole('checkbox', { name: 'Person 25' })
  for (let i = 25; i < 50; i++)
    fireEvent.click(screen.getByRole('checkbox', { name: `Person ${i}` }))
  fireEvent.click(screen.getByRole('button', { name: 'moreCandidates' }))
  expect(
    await screen.findByRole('checkbox', { name: 'Person 50' })
  ).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'submit' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce())
  expect(mocks.submit.mock.calls[0][0].user_ids).toHaveLength(50)
  expect(mocks.submit.mock.calls[0][0].organization_id).toBe(ORG)
})
