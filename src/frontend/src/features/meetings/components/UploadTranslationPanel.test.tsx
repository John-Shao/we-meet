import { selectOption } from '@/test/selectOption'
import { selectName } from '@/test/selectOption'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { UploadTranslationPanel } from './UploadTranslationPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
let denied = false
let stale = false
let canGenerate = true
let complete = true
let startMs = 1200
const job = () => ({
  id: 'translation',
  record_id: 'record',
  target: 'en',
  input_revision: 1,
  stale,
  status: 'succeeded',
  completed_chunks: 1,
  total_chunks: 1,
})
const show = (onSource = vi.fn(), positionMs?: number) => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <UploadTranslationPanel
        viewerId="owner"
        recordId="record"
        onSource={onSource}
        positionMs={positionMs}
      />
    </QueryClientProvider>
  )
  return onSource
}
beforeEach(() => {
  denied = stale = false
  canGenerate = complete = true
  startMs = 1200
  vi.mocked(fetchApi)
    .mockReset()
    .mockImplementation(async (path) => {
      if (denied) throw new ApiError(404, {})
      if (path.endsWith('upload-translations/'))
        return {
          can_generate: canGenerate,
          revision: 1,
          results: complete ? [job()] : [],
        }
      const next = path.includes('page=1')
      return {
        ...job(),
        next_page: next ? null : 1,
        results: [
          {
            segment_id: next ? 'last' : 'first',
            start_ms: startMs,
            end_ms: startMs + 2000,
            speaker_name: 'Speaker',
            text: next ? 'Last original' : 'Original',
            translated_text: next ? 'Last translation' : 'Translated',
          },
        ],
      }
    })
})
afterEach(() => {
  client?.clear()
  vi.useRealTimers()
})

it.each([
  [0, '0:00'],
  [1200, '0:01'],
  [59999, '0:59'],
  [60000, '1:00'],
  [3661000, '61:01'],
])(
  'shows %i milliseconds as elapsed time %s and seeks the same offset',
  async (milliseconds, expected) => {
    startMs = milliseconds
    const seek = show()
    await screen.findByText('Translated')
    expect(screen.getByText('Speaker')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `play ${expected}` }))
    expect(seek).toHaveBeenCalledWith(milliseconds)
  }
)

it('reads aligned text, seeks the original clock, exports the selected translation and appends pages while retaining earlier text', async () => {
  const seek = show()
  await screen.findByText('Translated')
  expect(screen.getByText('Original')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^play / }))
  expect(seek).toHaveBeenCalledWith(1200)
  fireEvent.click(
    screen.getByRole('button', { name: 'uploadTranslation.export' })
  )
  expect((await screen.findAllByRole('menuitem'))[0]).toHaveAttribute(
    'href',
    expect.stringContaining('translation/export/?as=txt')
  )
  fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'continuous.more' }))
  await screen.findByText('Last translation')
  expect(screen.queryByText('Translated')).toBeInTheDocument()
})
it('remembers original visibility and comparison layout across reopening', async () => {
  show()
  await screen.findByText('Translated')
  expect(
    screen
      .getByText('Translated')
      .compareDocumentPosition(screen.getByText('Original')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'sideBySide' }))
  expect(screen.getByText('Translated').parentElement).toHaveAttribute(
    'data-compare',
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'showOriginal' }))
  expect(screen.queryByText('Original')).not.toBeInTheDocument()
  expect(screen.getByText('Translated')).toBeInTheDocument()
  cleanup()
  client.clear()
  show()
  await screen.findByText('Translated')
  expect(screen.getByRole('button', { name: 'showOriginal' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  expect(screen.queryByText('Original')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'showOriginal' }))
  expect(screen.getByRole('button', { name: 'sideBySide' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

it('keeps the explanation behind an accessible information action', async () => {
  show()
  await screen.findByText('Translated')
  expect(screen.queryByText('description')).not.toBeInTheDocument()
  expect(screen.queryByText('generationHint')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'info' }))
  expect(await screen.findByText('description')).toBeInTheDocument()
})

it.each([
  [1200, true],
  [3199, true],
  [3200, false],
  [1000, false],
])(
  'highlights the source window at %i only when active (%s)',
  async (position, active) => {
    show(vi.fn(), position)
    const text = await screen.findByText('Translated')
    expect(text.closest('article')?.hasAttribute('aria-current')).toBe(active)
  }
)

it.each(['Unknown', ' unknown ', ''])(
  'localizes unknown speaker label %s',
  async (speaker) => {
    const read = vi.mocked(fetchApi).getMockImplementation()!
    vi.mocked(fetchApi).mockImplementation(async (path, options) => {
      const result = (await read(path, options)) as { results: object[] }
      return path.includes('?page=')
        ? {
            ...result,
            results: result.results.map((row) => ({
              ...row,
              speaker_name: speaker,
            })),
          }
        : result
    })
    show()
    await screen.findByText('Translated')
    expect(screen.getByText('unknownSpeaker')).toBeInTheDocument()
  }
)

it('marks a stale snapshot and disables its export and seek', async () => {
  stale = true
  show(vi.fn(), 1500)
  await screen.findByText('Translated')
  expect(screen.getByText('stale')).toBeInTheDocument()
  expect(screen.getByText('Translated').closest('article')).not.toHaveAttribute(
    'aria-current'
  )
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /^play / })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'regenerate' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'showOriginal' })).toBeVisible()
})
it('removes protected text when access revalidation fails and hides generation for readers', async () => {
  canGenerate = false
  show()
  await screen.findByText('Translated')
  expect(
    screen.queryByRole('button', { name: 'generate' })
  ).not.toBeInTheDocument()
  denied = true
  await act(() => client.invalidateQueries())
  await waitFor(() =>
    expect(screen.queryByText('Translated')).not.toBeInTheDocument()
  )
  expect(screen.getByRole('alert')).toHaveTextContent('unavailable')
})
it('keeps exactly the same paid intent after response loss', async () => {
  complete = false
  const read = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') throw new Error('lost response')
    return read(path, options)
  })
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'generate' }))
  await screen.findByText('uncertain')
  fireEvent.click(screen.getByRole('button', { name: 'check' }))
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(2)
  )
  const calls = vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body)
  expect(
    screen.getByRole('button', { name: selectName('language') })
  ).toBeDisabled()
})
it('changing language reads another product without issuing a paid request', async () => {
  show()
  await screen.findByText('Translated')
  await selectOption('language', 'zh')
  await screen.findByText('empty')
  expect(screen.queryByRole('button', { name: 'showOriginal' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'sideBySide' })).toBeNull()
  expect(screen.queryByText('Translated')).not.toBeInTheDocument()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([, options]) => options?.method === 'POST')
  ).toBe(false)
})

it.each([true, false])(
  'restores original visibility (%s) and comparison preferences after an empty language',
  async (showOriginal) => {
    const saved = JSON.stringify({ showOriginal, sideBySide: true })
    localStorage.setItem('we-meet:translation-view:owner', saved)
    show()
    await screen.findByText('Translated')
    await selectOption('language', 'zh')
    await screen.findByText('empty')
    expect(screen.queryByRole('button', { name: 'showOriginal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'sideBySide' })).toBeNull()
    expect(localStorage.getItem('we-meet:translation-view:owner')).toBe(saved)
    await selectOption('language', 'en')
    await screen.findByText('Translated')
    expect(
      screen.getByRole('button', { name: 'showOriginal' })
    ).toHaveAttribute('aria-pressed', String(showOriginal))
    if (!showOriginal)
      fireEvent.click(screen.getByRole('button', { name: 'showOriginal' }))
    expect(screen.getByRole('button', { name: 'sideBySide' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  }
)

it('hides reading controls when a completed translation contains no rows', async () => {
  const read = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    const result = await read(path, options)
    return path.includes('?page=')
      ? { ...(result as object), results: [], next_page: null }
      : result
  })
  show()
  await screen.findByText('status.succeeded')
  await waitFor(() => expect(screen.queryByText('loading')).toBeNull())
  expect(screen.queryByRole('button', { name: 'showOriginal' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'sideBySide' })).toBeNull()
})

it('rejects a response bound to another record', async () => {
  const read = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    const result = await read(path, options)
    return path.includes('?page=')
      ? { ...(result as object), record_id: 'another-record' }
      : result
  })
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
  expect(screen.queryByText('Translated')).not.toBeInTheDocument()
})

const listReads = () =>
  vi
    .mocked(fetchApi)
    .mock.calls.filter(
      ([path, options]) =>
        path.endsWith('upload-translations/') && options?.method !== 'POST'
    ).length

it.each(['failed', 'incomplete', 'canceled', 'succeeded'])(
  'polls queued and running tasks, then stops after %s',
  async (terminal) => {
    vi.useFakeTimers()
    let status = 'queued'
    const read = vi.mocked(fetchApi).getMockImplementation()!
    vi.mocked(fetchApi).mockImplementation(async (path, options) =>
      path.endsWith('upload-translations/')
        ? { can_generate: true, revision: 1, results: [{ ...job(), status }] }
        : read(path, options)
    )
    show()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(listReads()).toBe(1)
    expect(screen.queryByRole('button', { name: 'showOriginal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'sideBySide' })).toBeNull()
    status = 'running'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(listReads()).toBe(2)
    status = terminal
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(listReads()).toBe(3)
    expect(screen.getByText(`status.${terminal}`)).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(listReads()).toBe(3)
  }
)

it('does not poll an empty list', async () => {
  complete = false
  vi.useFakeTimers()
  show()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000)
  })
  expect(listReads()).toBe(1)
})

it('resumes polling after an explicit retry of a failed translation', async () => {
  vi.useFakeTimers()
  let status = 'failed'
  vi.mocked(fetchApi).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') {
      status = 'queued'
      return { ...job(), status }
    }
    return { can_generate: true, revision: 1, results: [{ ...job(), status }] }
  })
  show()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(listReads()).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'regenerate' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(listReads()).toBe(2)
  expect(screen.getByRole('status')).toHaveTextContent('status.queued')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(listReads()).toBe(3)
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.filter(([, options]) => options?.method === 'POST')
  ).toHaveLength(1)
})
