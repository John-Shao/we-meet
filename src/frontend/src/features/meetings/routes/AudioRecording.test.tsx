import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CaptureViewState } from '../capture/controller'
import type { LocalCapture } from '../capture/journal'
import { Recorder } from './AudioRecording'

const fixture = vi.hoisted(() => ({
  state: {} as CaptureViewState,
  load: vi.fn(),
  retry: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../components/MeetingModuleShell', () => ({
  MeetingModuleShell: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('../capture/journal', () => ({
  CaptureJournal: { open: async () => ({ close() {} }) },
}))
vi.mock('../capture/microphone', () => ({
  withCaptureLock: (_: string, callback: () => Promise<void>) => callback(),
}))
vi.mock('../capture/transport', () => ({
  captureTransport: () => ({}),
  textAudioAvailable: async () => false,
}))
vi.mock('../components/CaptureTranslationPanel', () => ({
  CaptureTranslationPanel: () => <p>live-translation</p>,
}))
vi.mock('../components/CaptureTranscriptionPanel', () => ({
  CaptureTranscriptionPanel: ({
    includeSummary,
  }: {
    includeSummary: boolean
  }) => <p>{includeSummary ? 'embedded-summary' : 'live-transcript'}</p>,
}))
vi.mock('../capture/controller', () => ({
  RecordingController: class {
    constructor(
      _: unknown,
      __: unknown,
      private changed: (state: CaptureViewState) => void
    ) {}
    async load(id?: string) {
      fixture.load(id)
      const local = id
        ? fixture.state.history.find((row) => row.id === id)
        : fixture.state.local
      fixture.state = { ...fixture.state, local }
      this.changed(fixture.state)
    }
    retryUploads = fixture.retry
    checkRetention() {}
    dispose() {}
  },
}))

function recording(id: string, sealed = true, pendingBytes = 0): LocalCapture {
  return {
    id,
    createdAt: '2026-09-15T00:00:00Z',
    createKey: id,
    create: {
      title: id,
      device_id: 'device',
      lease_key: 'lease',
      retention_mode: 'media',
    },
    nextSequence: 2,
    durationMs: 1000,
    pendingBytes,
    closed: true,
    sealed,
    remote: {
      id: `capture-${id}`,
      record_id: `record-${id}`,
      device_id: 'device',
      status: sealed ? 'stopped' : 'paused',
      revision: 1,
      started_at: '2026-09-15T00:00:00Z',
      ended_at: null,
      media_status: 'saved',
      captured_duration_ms: 1000,
      last_acked_sequence: 1,
      missing_ranges: null,
      coverage_status: 'unverified',
    },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
})

it('saved recordings link to their record and minutes instead of mounting archived workspaces', async () => {
  const local = recording('saved')
  fixture.state = { local, history: [local], mode: 'saved', busy: false }
  render(<Recorder viewerId="owner" available />)
  expect(
    await screen.findByRole('link', { name: 'openRecord' })
  ).toHaveAttribute('href', '/meeting/records/record-saved')
  expect(screen.getByRole('link', { name: 'openSummary' })).toHaveAttribute(
    'href',
    '/meeting/records/record-saved?tab=summary'
  )
  expect(screen.queryByText('live-transcript')).not.toBeInTheDocument()
  expect(screen.queryByText('live-translation')).not.toBeInTheDocument()
  expect(screen.queryByText('recoverable')).not.toBeInTheDocument()
})

it('keeps older local audio accessible and only offers upload retry before sealing', async () => {
  const history = Array.from({ length: 25 }, (_, i) => recording(`saved-${i}`))
  history.push(recording('pending-local', true, 16000))
  history.push(recording('unfinished-local', false, 16000))
  fixture.state = { local: history[0], history, mode: 'saved', busy: false }
  render(<Recorder viewerId="owner" available />)
  fireEvent.click(await screen.findByRole('button', { name: /pending-local/ }))
  await waitFor(() =>
    expect(fixture.load).toHaveBeenCalledWith('pending-local')
  )
  expect(
    screen.queryByRole('button', { name: 'retry' })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'showLocal' })).toBeEnabled()
  expect(
    screen.queryByRole('button', { name: /saved-24/ })
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /unfinished-local/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'retry' }))
  expect(fixture.retry).toHaveBeenCalledOnce()
})

it('retains live transcription and recovery controls without embedded minutes', async () => {
  const local = recording('unfinished', false, 16000)
  fixture.state = { local, history: [local], mode: 'recoverable', busy: false }
  render(<Recorder viewerId="owner" available />)
  expect(await screen.findByText('live-transcript')).toBeInTheDocument()
  expect(screen.getByText('live-translation')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'resume' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'retry' })).toBeEnabled()
  expect(screen.queryByText('embedded-summary')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'openSummary' })
  ).not.toBeInTheDocument()
})
