import { describe, expect, it } from 'vitest'
import {
  decodeTranslationEvent,
  updateTranslationRows,
  type TranslationRun,
} from './translationEvents'

const run: TranslationRun = {
  id: 'run',
  generation: 2,
  state: 'translating',
  source_participant_sid: 'PA_self',
  configuration: {
    source: 'zh',
    target: 'en',
    mode: 'push_to_talk',
    audio: true,
  },
}
const sender = { identity: 'translation-run-job', isAgent: true }
const frame = (changes = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      run_id: 'run',
      generation: 2,
      type: 'target_candidate',
      direction: 'forward',
      response_id: 'response',
      item_id: 'item',
      text: 'confirmed',
      stash: 'prediction',
      ...changes,
    })
  )

describe('Private translation events', () => {
  it('rejects another participant, run, generation or oversized payload', () => {
    expect(
      decodeTranslationEvent(frame(), { ...sender, isAgent: false }, run)
    ).toBeUndefined()
    expect(
      decodeTranslationEvent(
        frame(),
        { ...sender, identity: 'translation-other-job' },
        run
      )
    ).toBeUndefined()
    expect(
      decodeTranslationEvent(frame({ generation: 1 }), sender, run)
    ).toBeUndefined()
    expect(
      decodeTranslationEvent(frame({ run_id: 'other' }), sender, run)
    ).toBeUndefined()
    expect(
      decodeTranslationEvent(new Uint8Array(14001), sender, run)
    ).toBeUndefined()
    expect(
      decodeTranslationEvent(frame({ text: {} }), sender, run)
    ).toBeUndefined()
  })
  it('replaces partial text, separates predictions, and never regresses a final', () => {
    const preview = decodeTranslationEvent(frame(), sender, run)!
    let rows = updateTranslationRows([], preview)
    expect(rows[0]).toMatchObject({
      text: 'confirmed',
      stash: 'prediction',
      final: false,
    })
    rows = updateTranslationRows(rows, {
      ...preview,
      type: 'target_final',
      text: 'complete',
      stash: '',
    })
    rows = updateTranslationRows(rows, preview)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ text: 'complete', final: true })
  })
  it('retains only the most recent 60 segments', () => {
    let rows = updateTranslationRows(
      [],
      decodeTranslationEvent(frame(), sender, run)!
    )
    for (let i = 0; i < 80; i++)
      rows = updateTranslationRows(
        rows,
        decodeTranslationEvent(
          frame({ item_id: String(i), type: 'target_final' }),
          sender,
          run
        )!
      )
    expect(rows).toHaveLength(60)
    expect(rows[0].id.endsWith(':20')).toBe(true)
  })
  it('requires a valid ready sequence and explicit direction state', () => {
    expect(
      decodeTranslationEvent(
        frame({ type: 'ready', sequence: true }),
        sender,
        run
      )
    ).toBeUndefined()
    expect(
      decodeTranslationEvent(
        frame({ type: 'ready', sequence: 3, awaiting: true, direction: null }),
        sender,
        run
      )
    ).toMatchObject({ sequence: 3, awaiting: true })
  })
})
