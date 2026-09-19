import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ApiRecordSpeaker } from '../api/ApiMeetingRecord'
import { SpeakerAttributionControl } from './SpeakerAttributionControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}))
// The picker's buttons are the real primitive; it renders an <a> for a link
// variant and a <button> otherwise, and the tests below rely on the button.
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode
    onPress?: () => void
    isDisabled?: boolean
    'aria-label'?: string
  }) => (
    <button disabled={isDisabled} aria-label={ariaLabel} onClick={onPress}>
      {children}
    </button>
  ),
}))

let client: QueryClient
const speaker: ApiRecordSpeaker = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Speaker 1',
  identity_type: 'diarized',
  display_name: 'Speaker 1',
  attributed_user_id: null,
  can_attribute: true,
}

function show(overrides: Partial<ApiRecordSpeaker> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SpeakerAttributionControl
        recordId="record"
        viewerId="viewer"
        speaker={{ ...speaker, ...overrides }}
      />
    </QueryClientProvider>
  )
}

const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: /speakerAttribution.change/ }))
  return screen.findByLabelText('speakerAttribution.search')
}

/** The picker opens before the directory has landed, so wait for the list. */
const chooseButton = (name: string) =>
  screen.findByRole('button', { name: `speakerAttribution.choose:${name}` })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetchApi.mockResolvedValue({
    results: [{ id: 'user-1', name: 'Ada Lovelace' }],
  })
})
afterEach(() => client?.clear())

it('shows the resolved name and offers no control to a reader who cannot write it', () => {
  // A button whose only outcome is a 403 is worse than no button.
  show({ can_attribute: false, display_name: 'Ada Lovelace' })
  expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('reads the label underneath until a human binds the track', () => {
  // "Speaker 1" is what the recogniser produced, and it stays visible until
  // somebody says otherwise.
  show()
  expect(screen.getByText('Speaker 1')).toBeInTheDocument()
})

it('does not read the directory until the picker is opened', () => {
  // Most readers never attribute anyone, so an unused request is not worth one.
  show()
  expect(mocks.fetchApi).not.toHaveBeenCalled()
})

it('offers the directory from the record endpoint', async () => {
  show()
  await open()
  expect(await chooseButton('Ada Lovelace')).toBeInTheDocument()
  const url = mocks.fetchApi.mock.calls[0][0] as string
  expect(url).toContain('meeting-records/record/attribution-candidates/')
})

it('re-searches the directory with the typed name', async () => {
  show()
  const field = await open()
  await chooseButton('Ada Lovelace')
  const before = mocks.fetchApi.mock.calls.length
  fireEvent.change(field, { target: { value: 'ada' } })
  // Typing is not a search: `staleTime: 0` means every distinct key really does
  // hit the network, so a per-keystroke fetch would be a request storm.
  expect(mocks.fetchApi.mock.calls.length).toBe(before)
  fireEvent.click(screen.getByRole('button', { name: 'speakerAttribution.find' }))
  await vi.waitFor(() => {
    const url = mocks.fetchApi.mock.calls.at(-1)![0] as string
    expect(url).toContain('q=ada')
  })
})

it('binds the track to the chosen person', async () => {
  show()
  await open()
  fireEvent.click(await chooseButton('Ada Lovelace'))
  await vi.waitFor(() => {
    const call = mocks.fetchApi.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    )
    expect(call).toBeTruthy()
    // The speaker is addressed by its own id, not by the label a reader sees:
    // two tracks can share a name.
    expect(call![0]).toContain(`meeting-records/record/speakers/${speaker.id}/`)
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      user_id: 'user-1',
    })
  })
})

it('clears an attribution instead of refusing to', async () => {
  // Attributing the wrong colleague has to be undoable.
  show({ attributed_user_id: 'user-1', display_name: 'Ada Lovelace' })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'speakerAttribution.clear' }))
  await vi.waitFor(() => {
    const call = mocks.fetchApi.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    )
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      user_id: null,
    })
  })
})

it('says so when nobody matches rather than looking broken', async () => {
  mocks.fetchApi.mockResolvedValue({ results: [] })
  show()
  await open()
  expect(await screen.findByText('speakerAttribution.nobody')).toBeInTheDocument()
})

it('reports a failed write instead of failing silently', async () => {
  // A refused write (403, or a target outside the organization) must not look
  // like a success: the reader would go on believing the track was bound.
  mocks.fetchApi.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') throw new Error('refused')
    return { results: [{ id: 'user-1', name: 'Ada' }] }
  })
  show()
  await open()
  fireEvent.click(await chooseButton('Ada'))
  expect(await screen.findByText('speakerAttribution.failed')).toBeInTheDocument()
  // The picker stays open so the reader can try another person.
  expect(screen.getByLabelText('speakerAttribution.search')).toBeInTheDocument()
})

it('reports a directory that could not be read', async () => {
  mocks.fetchApi.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return null
    throw new Error('offline')
  })
  show()
  await open()
  expect(await screen.findByText('speakerAttribution.loadError')).toBeInTheDocument()
})
