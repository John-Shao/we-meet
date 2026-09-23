import { webcrypto, createHash } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  activeWordIndex,
  validateWords,
  type PlaybackAlignment,
} from './wordAlignment'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => vi.unstubAllGlobals())
export const fixture = (text = '我们，Hello 我们。'): PlaybackAlignment => ({
  status: 'available',
  version: 1,
  alignment_revision: 1,
  time_basis: 'segment_source',
  offset_unit: 'utf16',
  text_sha256: createHash('sha256').update(text).digest('hex'),
  tokens: [
    { start_offset: 0, end_offset: 2, start_ms: 0, end_ms: 400 },
    { start_offset: 3, end_offset: 8, start_ms: 500, end_ms: 900 },
    { start_offset: 9, end_offset: 11, start_ms: 900, end_ms: 1500 },
  ],
})

it('uses half-open intervals and clears gaps, invalid clocks and ended playback', async () => {
  const tokens = await validateWords('我们，Hello 我们。', fixture())
  expect(tokens).toHaveLength(3)
  expect(
    [0, 399, 400, 499, 500, 900, 1500, -1, NaN].map((ms) =>
      activeWordIndex(tokens, ms)
    )
  ).toEqual([0, 0, -1, -1, 1, 2, -1, -1, -1])
})
it('rejects corrections and unsupported contracts without hiding the text', async () => {
  expect(await validateWords('edited', fixture())).toEqual([])
  expect(
    await validateWords('我们，Hello 我们。', { ...fixture(), version: 2 })
  ).toEqual([])
  expect(await validateWords('我们，Hello 我们。')).toEqual([])
})
it('rejects overlap, missing lexical text and unsafe unicode boundaries', async () => {
  const data = fixture()
  data.tokens![1].start_ms = 300
  expect(await validateWords('我们，Hello 我们。', data)).toEqual([])
  const skipped = fixture()
  skipped.tokens = skipped.tokens!.slice(1)
  expect(await validateWords('我们，Hello 我们。', skipped)).toEqual([])
  const emoji = fixture('🙂')
  emoji.tokens = [{ start_offset: 0, end_offset: 1, start_ms: 0, end_ms: 10 }]
  expect(await validateWords('🙂', emoji)).toEqual([])
})
