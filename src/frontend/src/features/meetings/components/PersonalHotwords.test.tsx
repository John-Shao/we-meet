import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { PersonalHotwords } from './PersonalHotwords'
import { mergeHotwords } from '../personalHotwords'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
afterEach(() => vi.resetAllMocks())
const vocabulary = { words: ['Qwen', '妙记'], revision: 1 }
async function open(value = 'Existing\nQwen') {
  mocks.fetchApi.mockResolvedValue(vocabulary)
  const apply = vi.fn()
  const view = render(
    <PersonalHotwords
      viewerId="owner"
      value={value}
      disabled={false}
      onApply={apply}
    />
  )
  expect(mocks.fetchApi).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: 'personalHotwords.title' })
  )
  await screen.findByLabelText('personalHotwords.editor')
  return { apply, view }
}

it('opening and saving a vocabulary never change this upload without explicit merge', async () => {
  const { apply } = await open()
  expect(apply).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('personalHotwords.editor'), {
    target: { value: 'New' },
  })
  mocks.fetchApi.mockResolvedValueOnce({ words: ['New'], revision: 2 })
  fireEvent.click(screen.getByRole('button', { name: 'personalHotwords.save' }))
  await screen.findByText('personalHotwords.saved')
  expect(JSON.parse(mocks.fetchApi.mock.calls[1][1].body)).toEqual({
    text: 'New',
    expected_revision: 1,
  })
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: 'personalHotwords.apply' })
  )
  expect(apply).toHaveBeenCalledWith('Existing\nQwen\nNew')
})

it('merges and deduplicates in order without removing manual words', async () => {
  const { apply } = await open()
  fireEvent.click(
    screen.getByRole('button', { name: 'personalHotwords.apply' })
  )
  expect(apply).toHaveBeenCalledWith('Existing\nQwen\n妙记')
  expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
})

it('a stale save retains the draft until explicit discard and reload', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('personalHotwords.editor'), {
    target: { value: 'Draft' },
  })
  mocks.fetchApi.mockRejectedValueOnce(new ApiError(409, {}))
  fireEvent.click(screen.getByRole('button', { name: 'personalHotwords.save' }))
  await screen.findByText('personalHotwords.conflict')
  expect(screen.getByLabelText('personalHotwords.editor')).toHaveValue('Draft')
  expect(mocks.fetchApi).toHaveBeenCalledTimes(2)
  mocks.fetchApi.mockResolvedValueOnce({ words: ['Other device'], revision: 2 })
  fireEvent.click(
    screen.getByRole('button', { name: 'personalHotwords.reload' })
  )
  await waitFor(() =>
    expect(screen.getByLabelText('personalHotwords.editor')).toHaveValue(
      'Other device'
    )
  )
})

it('an overflowing merge leaves the upload untouched', async () => {
  const { apply } = await open(
    Array.from({ length: 100 }, (_, n) => `word${n}`).join('\n')
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'personalHotwords.apply' })
  )
  await screen.findByText('personalHotwords.limit')
  expect(apply).not.toHaveBeenCalled()
})

it('locks apply when the upload declaration has been submitted', async () => {
  const { view, apply } = await open()
  view.rerender(
    <PersonalHotwords
      viewerId="owner"
      value="Locked"
      disabled
      onApply={apply}
    />
  )
  expect(
    screen.getByRole('button', { name: 'personalHotwords.apply' })
  ).toBeDisabled()
  expect(screen.getByLabelText('personalHotwords.editor')).toBeDisabled()
})

it('switching accounts clears the previous vocabulary', async () => {
  const { view, apply } = await open()
  view.rerender(
    <PersonalHotwords
      viewerId="reader"
      value=""
      disabled={false}
      onApply={apply}
    />
  )
  expect(screen.queryByLabelText('personalHotwords.editor')).toBeNull()
  mocks.fetchApi.mockResolvedValueOnce({ words: [], revision: 0 })
  fireEvent.click(
    screen.getByRole('button', { name: 'personalHotwords.title' })
  )
  expect(await screen.findByLabelText('personalHotwords.editor')).toHaveValue(
    ''
  )
})

it('clearing uses the reviewed revision and never applies an empty library to the upload', async () => {
  const { apply } = await open()
  fireEvent.change(screen.getByLabelText('personalHotwords.editor'), {
    target: { value: '' },
  })
  mocks.fetchApi.mockResolvedValueOnce({ words: [], revision: 2 })
  fireEvent.click(screen.getByRole('button', { name: 'personalHotwords.save' }))
  await screen.findByText('personalHotwords.saved')
  expect(JSON.parse(mocks.fetchApi.mock.calls[1][1].body)).toEqual({
    text: '',
    expected_revision: 1,
  })
  expect(apply).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: 'personalHotwords.apply' })
  ).toBeDisabled()
})

it('counts Unicode characters and preserves distinct case while rejecting length overflow', () => {
  expect(mergeHotwords(' Qwen\r\nQwen\nqwen ', ['妙记'])).toBe(
    'Qwen\nqwen\n妙记'
  )
  expect(mergeHotwords('𠮷'.repeat(40), [])).toBe('𠮷'.repeat(40))
  expect(() => mergeHotwords('𠮷'.repeat(41), [])).toThrow()
  expect(() =>
    mergeHotwords(
      Array.from({ length: 100 }, (_, n) => `${n}`.padEnd(40, 'x')).join('\n'),
      []
    )
  ).toThrow()
})
