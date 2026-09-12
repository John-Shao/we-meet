import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
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
