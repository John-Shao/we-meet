import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <UploadMediaPlayer recordId="record" ref={handle} onPosition={() => {}} />
    </QueryClientProvider>
  )
}

afterEach(() => {
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

it('offers a player even though the record has no capture to read', async () => {
  // This is the whole point: an import is not playable through the chunked
  // capture path, so the absence of a playlist must not hide the controls.
  mocks.fetchApi.mockResolvedValue(media)
  show()
  expect(await screen.findByRole('button', { name: 'play' })).toBeInTheDocument()
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
