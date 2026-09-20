import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { UploadMediaPlayer, type UploadMediaHandle } from './UploadMediaPlayer'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: React.ReactNode
    onPress?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

const media = {
  url: 'https://private.example/recording.m4a?sig=test',
  expires_in: 3600,
  media_type: 'audio' as const,
  name: 'talk.m4a',
  size: 4096,
  content_type: 'audio/mp4',
}

function show(handle?: React.RefObject<UploadMediaHandle | null>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <UploadMediaPlayer recordId="record" ref={handle} onPosition={() => {}} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('resolves the signed read for the record and streams that url', async () => {
  mocks.fetchApi.mockResolvedValue(media)
  const { container } = show()
  await waitFor(() =>
    expect(container.querySelector('audio')).toHaveAttribute('src', media.url)
  )
  // The URL is short-lived, so it is fetched per mount rather than reused.
  expect(mocks.fetchApi).toHaveBeenCalledWith(
    'meeting-records/record/media/',
    expect.objectContaining({ cache: 'no-store' })
  )
  // Native controls are what give precise Range seeking for a sealed file.
  expect(container.querySelector('audio')).toHaveAttribute('controls')
})

it('reports prepared full-file duration and clears it on unmount', async () => {
  mocks.fetchApi.mockResolvedValue(media)
  const onDuration = vi.fn()
  const { container, unmount } = render(
    <UploadMediaPlayer recordId="record" onDuration={onDuration} />
  )
  await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
  const audio = container.querySelector('audio')!
  Object.defineProperty(audio, 'duration', {
    configurable: true,
    value: 47.123,
  })
  fireEvent.loadedMetadata(audio)
  expect(onDuration).toHaveBeenLastCalledWith(47123)
  Object.defineProperty(audio, 'duration', {
    configurable: true,
    value: Infinity,
  })
  fireEvent.durationChange(audio)
  expect(onDuration).toHaveBeenLastCalledWith(null)
  unmount()
  expect(onDuration).toHaveBeenLastCalledWith(null)
})

it('offers a player even though the record has no capture to read', async () => {
  // This is the whole point: an import is not playable through the chunked
  // capture path, so the absence of a playlist must not hide the controls.
  mocks.fetchApi.mockResolvedValue(media)
  show()
  expect(
    await screen.findByRole('button', { name: 'play' })
  ).toBeInTheDocument()
  expect(screen.queryByText('audioError')).not.toBeInTheDocument()
})

it('reports a position in the source clock so the transcript can follow', async () => {
  const positions: number[] = []
  mocks.fetchApi.mockResolvedValue(media)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const { container } = render(
    <QueryClientProvider client={client}>
      <UploadMediaPlayer
        recordId="record"
        onPosition={(ms) => positions.push(ms)}
      />
    </QueryClientProvider>
  )
  await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
  const audio = container.querySelector('audio')!
  Object.defineProperty(audio, 'currentTime', { value: 12.5, writable: true })
  fireEvent.timeUpdate(audio)
  expect(positions).toContain(12_500)
})

it('seeks the element when a transcript citation asks for a position', async () => {
  mocks.fetchApi.mockResolvedValue(media)
  const handle = createRef<UploadMediaHandle>()
  const { container } = show(handle)
  await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
  handle.current!.seek(65_000)
  expect(container.querySelector('audio')!.currentTime).toBe(65)
})

it('degrades to a visible error when the signed read is refused', async () => {
  mocks.fetchApi.mockRejectedValue(new Error('404'))
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent('audioError')
  expect(screen.queryByRole('button', { name: 'play' })).not.toBeInTheDocument()
})

it('renders video imports with a picture and keeps audio imports compact', async () => {
  mocks.fetchApi.mockResolvedValue({ ...media, media_type: 'video' })
  const { container } = show()
  await waitFor(() =>
    expect(container.querySelector('video')).toHaveAttribute('src', media.url)
  )
  expect(container.querySelector('video')).toHaveAttribute('playsinline')
  expect(container.querySelector('audio')).toBeNull()
})

it.each([false, true])(
  'renews the URL retaining position and speed, playing=%s',
  async (playing) => {
    vi.useFakeTimers()
    mocks.fetchApi
      .mockResolvedValueOnce({ ...media, expires_in: 10 })
      .mockResolvedValue({
        ...media,
        url: 'https://private.example/renewed',
        expires_in: 10,
      })
    const view = show()
    await act(async () => {
      await Promise.resolve()
    })
    const audio = view.container.querySelector('audio')!
    Object.defineProperty(audio, 'duration', { value: 120 })
    audio.currentTime = 42
    fireEvent.timeUpdate(audio)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1.5' } })
    if (playing) fireEvent.play(audio)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })
    expect(audio).toHaveAttribute('src', 'https://private.example/renewed')
    audio.currentTime = 0
    fireEvent.timeUpdate(audio)
    fireEvent.loadedMetadata(audio)
    expect(audio.currentTime).toBe(42)
    expect(audio.playbackRate).toBe(1.5)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(
      playing ? 1 : 0
    )
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(mocks.fetchApi).toHaveBeenCalledTimes(2)
  }
)

it('queues citation seeks until metadata is available and retries a failed lease', async () => {
  const handle = createRef<UploadMediaHandle>()
  mocks.fetchApi
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(media)
  const view = show(handle)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'asr.refresh' }))
  act(() => handle.current!.seek(65000))
  await waitFor(() =>
    expect(view.container.querySelector('audio')).toBeTruthy()
  )
  const audio = view.container.querySelector('audio')!
  Object.defineProperty(audio, 'duration', { value: 120 })
  fireEvent.loadedMetadata(audio)
  expect(audio.currentTime).toBe(65)
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
})

it('stops exposing media when lease renewal is refused', async () => {
  vi.useFakeTimers()
  mocks.fetchApi
    .mockResolvedValueOnce({ ...media, expires_in: 10 })
    .mockRejectedValue(new Error('revoked'))
  const view = show()
  await act(async () => {
    await Promise.resolve()
  })
  expect(view.container.querySelector('audio')).not.toBeNull()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000)
  })
  expect(view.container.querySelector('audio')).toBeNull()
  expect(screen.getByRole('alert')).toBeInTheDocument()
})
