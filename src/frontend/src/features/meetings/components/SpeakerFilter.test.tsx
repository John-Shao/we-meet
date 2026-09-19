import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'

import { SpeakerFilter } from './SpeakerFilter'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const speakers = {
  results: [
    { id: 'sp-a', label: 'Speaker A', identity_type: 'diarized' },
    { id: 'sp-b', label: 'Speaker B', identity_type: 'diarized' },
    { id: 'sp-unknown', label: 'Speaker 3', identity_type: 'unknown' },
  ],
  next_cursor: null,
}

function show(selected = '', onSelect = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <SpeakerFilter
        viewerId="owner"
        recordId="record"
        revision={3}
        selected={selected}
        onSelect={onSelect}
      />
    </QueryClientProvider>
  )
  return onSelect
}

beforeEach(() => {
  vi.resetAllMocks()
})

it('offers every speaker plus an explicit "all" option', async () => {
  mocks.fetchApi.mockResolvedValue(speakers)
  show()
  const select = await screen.findByRole('combobox')
  await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(4))
  const options = Array.from(select.querySelectorAll('option')).map((o) => ({
    value: (o as HTMLOptionElement).value,
    label: o.textContent,
  }))
  expect(options[0]).toEqual({ value: '', label: 'library.allSpeakers' })
  // The filter token is the stable id, never the display name.
  expect(options[1]).toEqual({ value: 'sp-a', label: 'Speaker A' })
  // An unidentified diarized speaker must not be presented as a person name.
  expect(options[3]).toEqual({
    value: 'sp-unknown',
    label: 'library.unknownSpeaker',
  })
})

it('reports the chosen speaker token, not the label', async () => {
  mocks.fetchApi.mockResolvedValue(speakers)
  const onSelect = show()
  const select = await screen.findByRole('combobox')
  fireEvent.change(select, { target: { value: 'sp-b' } })
  expect(onSelect).toHaveBeenCalledWith('sp-b')
})

it('reads speakers for the exact record revision', async () => {
  mocks.fetchApi.mockResolvedValue(speakers)
  show()
  await screen.findByRole('combobox')
  expect(mocks.fetchApi.mock.calls[0][0]).toBe(
    'meeting-records/record/speakers/'
  )
})

it('stays out of the way when a record has a single speaker', async () => {
  mocks.fetchApi.mockResolvedValue({
    results: [speakers.results[0]],
    next_cursor: null,
  })
  show()
  await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalled())
  // A filter over one option is noise; the transcript already shows one person.
  await waitFor(() =>
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  )
})

it('keeps an active filter visible even if the list is now short', async () => {
  // Losing the list must not strand the user in a filtered view they cannot clear.
  mocks.fetchApi.mockResolvedValue({
    results: [speakers.results[0]],
    next_cursor: null,
  })
  show('sp-b')
  expect(await screen.findByRole('combobox')).toHaveValue('sp-b')
})

it('renders nothing when the speaker read fails', async () => {
  mocks.fetchApi.mockRejectedValue(new ApiError(403, {}))
  show()
  await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalled())
  // A failed read must not look like "this record has no speakers".
  await waitFor(() =>
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  )
})

it('clears the filter back to every speaker', async () => {
  mocks.fetchApi.mockResolvedValue(speakers)
  const onSelect = show('sp-a')
  const select = await screen.findByRole('combobox')
  await waitFor(() => expect(select).toHaveValue('sp-a'))
  fireEvent.change(select, { target: { value: '' } })
  expect(onSelect).toHaveBeenCalledWith('')
})
