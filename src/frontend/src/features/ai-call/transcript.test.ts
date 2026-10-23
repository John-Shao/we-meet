import { describe, expect, it } from 'vitest'
import { mergeTranscript, type TranscriptEntry } from './transcript'

const row = (id: string, createdAt: number) => ({
  id,
  role: 'user' as const,
  text: id,
  createdAt,
})

const labels = <T extends { id: string; createdAt?: number }>(
  entries: TranscriptEntry<T>[]
) => entries.map((entry) => (entry.kind === 'read' ? 'read' : entry.row.id))

describe('AI call transcript order', () => {
  it('keeps the read card where it happened', () => {
    const rows = [
      row('q1', 100),
      row('a1', 250),
      row('q2', 400),
      row('a2', 500),
    ]
    expect(labels(mergeTranscript(rows, 200))).toEqual([
      'q1',
      'read',
      'a1',
      'q2',
      'a2',
    ])
  })

  it('keeps the card last when the read is the newest entry', () => {
    const rows = [row('q1', 100), row('a1', 200)]
    expect(labels(mergeTranscript(rows, 300))).toEqual(['q1', 'a1', 'read'])
  })

  it('omits the card when nothing was read', () => {
    expect(labels(mergeTranscript([row('q1', 100)], null))).toEqual(['q1'])
  })

  it('falls back to the end for a read without a timestamp', () => {
    expect(labels(mergeTranscript([row('q1', 100)], 0))).toEqual(['q1', 'read'])
  })
})
