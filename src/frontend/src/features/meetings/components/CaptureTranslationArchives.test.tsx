import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { run, source } from '../capture/translation.testFixtures'
import { CaptureTranslationArchives } from './CaptureTranslationArchives'
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
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
const archiveId = '66666666-6666-4666-8666-666666666666'
const segmentId = '77777777-7777-4777-8777-777777777777'
let failed = false
let wrongSource = false
let more = false
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CaptureTranslationArchives {...source} />
    </QueryClientProvider>
  )
beforeEach(() => {
  vi.clearAllMocks()
  failed = false
  wrongSource = false
  more = false
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    if (failed) throw new ApiError(403, {})
    const root = {
      capture_id: wrongSource ? crypto.randomUUID() : source.captureId,
      record_id: source.recordId,
      next_cursor: null,
    }
    if (path.includes(`${archiveId}/`))
      return {
        ...root,
        archive_id: archiveId,
        run_id: run().id,
        generation: 1,
        archive_status: 'incomplete',
        results: [
          {
            id: segmentId,
            sequence: path.includes('cursor=next') ? 51 : 1,
            source_capture_id: source.captureId,
            direction: 'forward',
            target: 'en',
            text: path.includes('cursor=next')
              ? 'Next translated page'
              : 'Confirmed translated text',
            received_at: new Date().toISOString(),
            timing_basis: 'delivery',
            original_id: null,
          },
        ],
        next_cursor: more && !path.includes('cursor=next') ? 'next' : null,
      }
    return {
      ...root,
      results: [
        {
          id: archiveId,
          run_id: run().id,
          capture_id: source.captureId,
          generation: 1,
          configuration: { ...run().configuration, save_translations: true },
          status: 'incomplete',
          segment_count: 1,
          created_at: new Date().toISOString(),
        },
      ],
    }
  })
})
it('opens confirmed text with partial-save status and no fake media seeking', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'open' }))
  expect(
    await screen.findByText('Confirmed translated text')
  ).toBeInTheDocument()
  expect(screen.getByText('incomplete')).toBeInTheDocument()
  expect(screen.getByText('timing')).toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})
it('hides cached private text after a denied refresh', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'open' }))
  await screen.findByText('Confirmed translated text')
  failed = true
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await screen.findByRole('alert')
  expect(
    screen.queryByText('Confirmed translated text')
  ).not.toBeInTheDocument()
})
it('unmounts private text on background and reauthorizes when returning', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'open' }))
  await screen.findByText('Confirmed translated text')
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(
    screen.queryByText('Confirmed translated text')
  ).not.toBeInTheDocument()
  failed = true
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await screen.findByRole('alert')
})
it('replaces pages without accumulating text and refuses wrong source envelopes', async () => {
  more = true
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'open' }))
  await screen.findByText('Confirmed translated text')
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  await screen.findByText('Next translated page')
  expect(
    screen.queryByText('Confirmed translated text')
  ).not.toBeInTheDocument()
  wrongSource = true
  fireEvent.click(screen.getByRole('button', { name: 'previous' }))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('error')
  )
  expect(screen.queryByText('Next translated page')).not.toBeInTheDocument()
})
