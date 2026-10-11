import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import {
  CaptureAudioPlayer,
  type CaptureAudioHandle,
} from './CaptureAudioPlayer'
import {
  audioChunk,
  audioPlaylist,
  checkAudioAccess,
} from '../capture/playback'

vi.mock('../capture/playback', async (original) => ({
  ...(await original<typeof import('../capture/playback')>()),
  audioChunk: vi.fn(),
  audioPlaylist: vi.fn(),
  checkAudioAccess: vi.fn(),
}))
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

beforeEach(() => {
  setTokens({ accessToken: 'synthetic-capture' })
  vi.mocked(audioPlaylist).mockResolvedValue({
    manifest: null,
    chunks: [
      {
        id: 'a',
        sequence: 1,
        start_ms: 0,
        duration_ms: 1000,
        byte_size: 32044,
        checksum: 'sha',
        stored: true,
      },
      {
        id: 'c',
        sequence: 3,
        start_ms: 2000,
        duration_ms: 1000,
        byte_size: 32044,
        checksum: 'sha',
        stored: true,
      },
    ],
  })
  vi.mocked(audioChunk).mockResolvedValue(new Blob(['audio']))
  vi.mocked(checkAudioAccess).mockResolvedValue({})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
    () => undefined
  )
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
    () => undefined
  )
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:private-audio'),
      revokeObjectURL: vi.fn(),
    })
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('plays the source position selected from the transcript', async () => {
  const ref = createRef<CaptureAudioHandle>()
  const { container } = render(
    <CaptureAudioPlayer ref={ref} captureId="capture" />
  )
  await screen.findByRole('button', { name: 'play' })
  act(() => ref.current!.seek(2500))
  await screen.findByRole('button', { name: 'pausePlayback' })
  expect(vi.mocked(audioChunk).mock.calls[0][1].id).toBe('c')
  expect(container.querySelector('audio')!.currentTime).toBe(0.5)
})

it('retains volume across chunk changes and restores sound from zero', async () => {
  const ref = createRef<CaptureAudioHandle>()
  const { container } = render(
    <CaptureAudioPlayer ref={ref} captureId="capture" />
  )
  await screen.findByRole('button', { name: 'play' })
  const audio = container.querySelector('audio')!
  fireEvent.change(screen.getByRole('slider', { name: 'playbackVolume' }), {
    target: { value: '0.4' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'mutePlayback' }))
  act(() => ref.current!.seek(2500))
  await screen.findByRole('button', { name: 'pausePlayback' })
  expect(audio.volume).toBe(0.4)
  expect(audio.muted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'unmutePlayback' }))
  fireEvent.change(screen.getByRole('slider', { name: 'playbackVolume' }), {
    target: { value: '0' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'unmutePlayback' }))
  expect(audio.muted).toBe(false)
  expect(audio.volume).toBe(1)
})

it('pauses at missing audio and continues only after an explicit skip', async () => {
  const { container } = render(<CaptureAudioPlayer captureId="capture" />)
  await screen.findByRole('button', { name: 'play' })
  fireEvent.click(screen.getByRole('button', { name: 'play' }))
  await screen.findByRole('button', { name: 'pausePlayback' })
  fireEvent.ended(container.querySelector('audio')!)
  await screen.findByText('audioGap')
  expect(audioChunk).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'skipGap' }))
  await screen.findByRole('button', { name: 'pausePlayback' })
  expect(vi.mocked(audioChunk).mock.calls[1][1].id).toBe('c')
})

it('ignores a late download after switching viewer or recording', async () => {
  let resolve!: (blob: Blob) => void
  vi.mocked(audioChunk).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const { unmount } = render(<CaptureAudioPlayer captureId="old-capture" />)
  await screen.findByRole('button', { name: 'play' })
  fireEvent.click(screen.getByRole('button', { name: 'play' }))
  unmount()
  await act(async () => resolve(new Blob(['late'])))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('clears private audio on a revoked access check', async () => {
  const { container } = render(<CaptureAudioPlayer captureId="capture" />)
  await screen.findByRole('button', { name: 'play' })
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'play' }))
  await act(async () => {
    await Promise.resolve()
  })
  vi.mocked(checkAudioAccess).mockRejectedValue(new Error('denied'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  vi.useRealTimers()
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('audioError')
  )
  expect(container.querySelector('audio')).not.toHaveAttribute('src')
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-audio')
})

it('treats the exact end of the timeline as completed, not as missing audio', async () => {
  render(<CaptureAudioPlayer captureId="capture" />)
  await screen.findByRole('button', { name: 'play' })
  const slider = screen.getByRole('slider', { name: 'audioPosition' })
  fireEvent.keyDown(slider, { key: 'End' })
  fireEvent.change(slider, { target: { value: '3000' } })
  fireEvent.keyUp(slider, { key: 'End' })
  expect(screen.queryByText('audioGap')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'play' }))
  await screen.findByRole('button', { name: 'pausePlayback' })
  expect(vi.mocked(audioChunk).mock.calls[0][1].id).toBe('a')
})

it('previews only a bounded source interval and clears bytes at its end', async () => {
  const ref = createRef<CaptureAudioHandle>()
  const { container } = render(
    <CaptureAudioPlayer ref={ref} captureId="capture" />
  )
  await screen.findByRole('button', { name: 'play' })
  let ok = false
  await act(async () => {
    ok = await ref.current!.preview(100, 700)
  })
  expect(ok).toBe(true)
  const audio = container.querySelector('audio')!
  expect(audio.currentTime).toBe(0.1)
  audio.currentTime = 0.75
  fireEvent.timeUpdate(audio)
  expect(audio).not.toHaveAttribute('src')
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})
it('refuses missing audio and oversized preview ranges before downloading', async () => {
  const ref = createRef<CaptureAudioHandle>()
  render(<CaptureAudioPlayer ref={ref} captureId="capture" />)
  await screen.findByRole('button', { name: 'play' })
  await act(async () => {
    expect(await ref.current!.preview(900, 2100)).toBe(false)
    expect(await ref.current!.preview(0, 10001)).toBe(false)
    expect(await ref.current!.preview(NaN, 500)).toBe(false)
  })
  expect(audioChunk).not.toHaveBeenCalled()
})
it('continues a preview across consecutive chunks and stops before loading the next speaker', async () => {
  vi.mocked(audioPlaylist).mockResolvedValue({
    manifest: null,
    chunks: [0, 1, 2].map((index) => ({
      id: String(index),
      sequence: index + 1,
      start_ms: index * 1000,
      duration_ms: 1000,
      byte_size: 32044,
      checksum: 'sha',
      stored: true,
    })),
  })
  const ref = createRef<CaptureAudioHandle>()
  const { container } = render(
    <CaptureAudioPlayer ref={ref} captureId="capture" />
  )
  await screen.findByRole('button', { name: 'play' })
  await act(async () => {
    expect(await ref.current!.preview(500, 1500)).toBe(true)
  })
  const audio = container.querySelector('audio')!
  fireEvent.ended(audio)
  await waitFor(() => expect(audioChunk).toHaveBeenCalledTimes(2))
  await screen.findByRole('button', { name: 'pausePlayback' })
  audio.currentTime = 0.6
  fireEvent.timeUpdate(audio)
  expect(audio).not.toHaveAttribute('src')
  expect(audioChunk).toHaveBeenCalledTimes(2)
})
it('does not stop ordinary playback when an unused identification panel closes', async () => {
  const ref = createRef<CaptureAudioHandle>()
  const { container } = render(
    <CaptureAudioPlayer ref={ref} captureId="capture" />
  )
  await screen.findByRole('button', { name: 'play' })
  fireEvent.click(screen.getByRole('button', { name: 'play' }))
  await screen.findByRole('button', { name: 'pausePlayback' })
  act(() => ref.current!.stopPreview())
  expect(container.querySelector('audio')).toHaveAttribute('src')
})
it('aborts a late preview download when preview is stopped', async () => {
  let resolve!: (value: Blob) => void
  vi.mocked(audioChunk).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const ref = createRef<CaptureAudioHandle>()
  render(<CaptureAudioPlayer ref={ref} captureId="capture" />)
  await screen.findByRole('button', { name: 'play' })
  let result!: Promise<boolean>
  act(() => {
    result = ref.current!.preview(100, 600)
  })
  act(() => ref.current!.stopPreview())
  await act(async () => {
    resolve(new Blob(['late']))
    expect(await result).toBe(false)
  })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})
it('clears a preview and cached playlist on account change', async () => {
  const ref = createRef<CaptureAudioHandle>()
  const { container } = render(
    <CaptureAudioPlayer ref={ref} captureId="capture" />
  )
  await screen.findByRole('button', { name: 'play' })
  await act(async () => {
    expect(await ref.current!.preview(100, 700)).toBe(true)
  })
  act(() => {
    setTokens({ accessToken: 'another-synthetic' })
    window.dispatchEvent(new Event('storage'))
  })
  await screen.findByText('audioError')
  expect(container.querySelector('audio')).not.toHaveAttribute('src')
})
