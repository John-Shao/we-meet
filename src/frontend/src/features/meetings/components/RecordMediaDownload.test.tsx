import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RecordMediaDownload } from './RecordMediaDownload'
import type { ApiMeetingRecord } from '../api/ApiMeetingRecord'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const record = {
  id: 'r',
  source_type: 'upload',
  capabilities: { download_media: true },
} as ApiMeetingRecord
afterEach(() => {
  vi.restoreAllMocks()
  mocks.fetchApi.mockReset()
})

it('requests an attachment and lets the browser download without fetching file bytes', async () => {
  mocks.fetchApi.mockResolvedValue({
    url: 'https://media.example/file?signature=x',
    name: 'meeting.wav',
    expires_in: 600,
  })
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {})
  render(<RecordMediaDownload record={record} />)
  fireEvent.click(screen.getByRole('button', { name: 'mediaDownload.action' }))
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
  expect(mocks.fetchApi).toHaveBeenCalledWith(
    'meeting-records/r/media/?download=true',
    expect.objectContaining({ cache: 'no-store' })
  )
  const link = click.mock.contexts[0] as HTMLAnchorElement
  expect(link.download).toBe('meeting.wav')
  expect(link.href).toBe('https://media.example/file?signature=x')
  expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
})

it('does not expose download for a transcript-only reader', () => {
  render(
    <RecordMediaDownload
      record={{
        ...record,
        capabilities: { ...record.capabilities, download_media: false },
      }}
    />
  )
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(mocks.fetchApi).not.toHaveBeenCalled()
})

it('does not navigate from a late response after the permission boundary unmounts', async () => {
  let resolve!: (value: unknown) => void
  mocks.fetchApi.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {})
  const view = render(<RecordMediaDownload record={record} />)
  fireEvent.click(screen.getByRole('button', { name: 'mediaDownload.action' }))
  view.unmount()
  await act(async () =>
    resolve({
      url: 'https://media.example/file',
      name: 'meeting.wav',
      expires_in: 600,
    })
  )
  expect(click).not.toHaveBeenCalled()
})

it('rejects unsafe URLs and allows retry after failure', async () => {
  mocks.fetchApi.mockResolvedValue({
    url: 'javascript:alert(1)',
    name: 'meeting.wav',
    expires_in: 600,
  })
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {})
  render(<RecordMediaDownload record={record} />)
  fireEvent.click(screen.getByRole('button', { name: 'mediaDownload.action' }))
  await screen.findByRole('alert')
  expect(click).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: 'mediaDownload.action' })
  ).not.toBeDisabled()
})
