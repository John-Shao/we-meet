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
  // One shared control bar drives the browser's existing Range-capable element.
  expect(container.querySelector('audio')).not.toHaveAttribute('controls')
  expect(container.querySelector('audio')).toHaveAttribute('hidden')
  expect(screen.getByRole('slider', { name: 'audioPosition' })).toBeDisabled()
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

it('samples the real media clock between timeupdate events and stops on pause', async () => {
  mocks.fetchApi.mockResolvedValue(media)
  let callback: FrameRequestCallback | undefined
  const raf = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((fn) => {
      callback = fn
      return 123
    })
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation(() => {})
  const onPosition = vi.fn()
  const view = render(
    <UploadMediaPlayer recordId="record" onPosition={onPosition} />
  )
  await waitFor(() =>
    expect(view.container.querySelector('audio')).not.toBeNull()
  )
  const audio = view.container.querySelector('audio')!
  fireEvent.play(audio)
  Object.defineProperty(audio, 'currentTime', { value: 0.55, writable: true })
  act(() => callback?.(100))
  expect(onPosition).toHaveBeenLastCalledWith(550)
  const count = onPosition.mock.calls.length
  act(() => callback?.(200))
  expect(onPosition).toHaveBeenCalledTimes(count) // stalled clock must not advance
  Object.defineProperty(audio, 'seeking', { value: true, configurable: true })
  audio.currentTime = 9
  act(() => callback?.(300))
  expect(onPosition).toHaveBeenCalledTimes(count)
  fireEvent.pause(audio)
  expect(cancel).toHaveBeenCalledWith(123)
  view.unmount()
  raf.mockRestore()
  cancel.mockRestore()
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

it('keeps the same video element and paused position when collapsing the preview', async () => {
  mocks.fetchApi.mockResolvedValue({ ...media, media_type: 'video' })
  const { container } = show()
  await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
  const video = container.querySelector('video')!
  Object.defineProperty(video, 'duration', { value: 120 })
  Object.defineProperty(video, 'readyState', { value: 2 })
  fireEvent.loadedMetadata(video)
  fireEvent.change(screen.getByRole('slider', { name: 'audioPosition' }), {
    target: { value: '42000' },
  })
  expect(video.currentTime).toBe(42)
  fireEvent.click(screen.getByRole('button', { name: 'hideVideo' }))
  expect(video).toHaveAttribute('hidden')
  fireEvent.click(screen.getByRole('button', { name: 'showVideo' }))
  expect(video).not.toHaveAttribute('hidden')
  expect(container.querySelector('video')).toBe(video)
  expect(video.currentTime).toBe(42)
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
})

it.each(['audio', 'video', 'collapsed video'])(
  'allows the first forward skip before metadata in %s mode',
  async (mode) => {
    mocks.fetchApi.mockResolvedValue({
      ...media,
      media_type: mode === 'audio' ? 'audio' : 'video',
    })
    const { container } = show()
    await waitFor(() => expect(container.querySelector('audio, video')).not.toBeNull())
    if (mode === 'collapsed video') {
      fireEvent.click(screen.getByRole('button', { name: 'hideVideo' }))
    }
    const element = container.querySelector('audio, video') as HTMLMediaElement
    expect(screen.getByRole('button', { name: 'skipBack' })).toBeDisabled()
    const forward = screen.getByRole('button', { name: 'skipForward' })
    expect(forward).toBeEnabled()
    fireEvent.click(forward)
    Object.defineProperty(element, 'duration', { value: 47 })
    fireEvent.loadedMetadata(element)
    expect(element.currentTime).toBe(15)
    expect(screen.getByRole('button', { name: 'skipBack' })).toBeEnabled()
  }
)

it.each(['audio', 'video', 'collapsed video'])(
  'disables forward on natural completion with a short final clock sample in %s mode',
  async (mode) => {
    mocks.fetchApi.mockResolvedValue({ ...media, media_type: mode === 'audio' ? 'audio' : 'video' })
    const { container } = show()
    await waitFor(() => expect(container.querySelector('audio, video')).not.toBeNull())
    if (mode === 'collapsed video') fireEvent.click(screen.getByRole('button', { name: 'hideVideo' }))
    const element = container.querySelector('audio, video') as HTMLMediaElement
    Object.defineProperty(element, 'duration', { value: 47 })
    Object.defineProperty(element, 'readyState', { value: 2 })
    fireEvent.loadedMetadata(element)
    fireEvent.play(element)
    element.currentTime = 46.96
    fireEvent.timeUpdate(element)
    fireEvent.ended(element)
    expect(screen.getByRole('button', { name: 'skipForward' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'skipBack' }))
    expect(element.currentTime).toBe(32)
    expect(screen.getByRole('button', { name: 'skipForward' })).toBeEnabled()
    fireEvent.ended(element)
    fireEvent.click(screen.getByRole('button', { name: 'play' }))
    expect(element.currentTime).toBe(0)
    expect(screen.getByRole('button', { name: 'skipForward' })).toBeEnabled()
  }
)

it('clamps timeline jumps to the known duration and preserves playback speed', async () => {
  mocks.fetchApi.mockResolvedValue(media)
  const { container } = show()
  await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
  const audio = container.querySelector('audio')!
  Object.defineProperty(audio, 'duration', { value: 25 })
  Object.defineProperty(audio, 'readyState', { value: 2 })
  fireEvent.loadedMetadata(audio)
  expect(screen.getByRole('button', { name: 'skipBack' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'skipForward' })).toBeEnabled()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '1.5' } })
  fireEvent.change(screen.getByRole('slider', { name: 'audioPosition' }), {
    target: { value: '24000' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'skipForward' }))
  expect(audio.currentTime).toBe(25)
  expect(screen.getByRole('button', { name: 'skipForward' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'skipBack' })).toBeEnabled()
  expect(audio.playbackRate).toBe(1.5)
  fireEvent.change(screen.getByRole('slider', { name: 'audioPosition' }), {
    target: { value: '1000' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'skipBack' }))
  expect(audio.currentTime).toBe(0)
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
    fireEvent.change(screen.getByRole('slider', { name: 'playbackVolume' }), {
      target: { value: '0.35' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'mutePlayback' }))
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
    expect(audio.volume).toBe(0.35)
    expect(audio.muted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'unmutePlayback' }))
    expect(audio.muted).toBe(false)
    expect(audio.volume).toBe(0.35)
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
