export type TranslationDirection = 'forward' | 'reverse'
export interface TranslationRun {
  id: string
  generation: number
  state: 'starting' | 'translating' | 'stopping' | 'stopped' | 'incomplete'
  source_participant_sid: string | null
  configuration: {
    source: 'zh' | 'en'
    target: 'zh' | 'en'
    mode: 'simultaneous' | 'push_to_talk'
    audio: boolean
  }
}
export interface TranslationRow {
  id: string
  direction: TranslationDirection
  text: string
  stash: string
  final: boolean
}
export interface TranslationEvent {
  type: 'ready' | 'turn_completed' | 'target_candidate' | 'target_final'
  sequence?: number
  direction?: TranslationDirection | null
  awaiting?: boolean
  response_id?: string
  item_id?: string
  text?: string
  stash?: string
}

export const isTranslationAgent = (identity: string) =>
  identity.startsWith('translation-')

export function decodeTranslationEvent(
  payload: Uint8Array,
  sender: { identity: string; isAgent: boolean } | undefined,
  run: TranslationRun
): TranslationEvent | undefined {
  if (
    payload.byteLength > 14000 ||
    !sender?.isAgent ||
    !sender.identity.startsWith(`translation-${run.id}-`)
  )
    return
  try {
    const data = JSON.parse(new TextDecoder().decode(payload))
    if (data.run_id !== run.id || data.generation !== run.generation) return
    const direction =
      data.direction === 'forward' || data.direction === 'reverse'
    if (data.type === 'ready') {
      if (
        !Number.isSafeInteger(data.sequence) ||
        data.sequence < 0 ||
        typeof data.awaiting !== 'boolean' ||
        (!direction && data.direction !== null)
      )
        return
    } else if (data.type === 'turn_completed') {
      if (!direction) return
    } else if (
      data.type === 'target_candidate' ||
      data.type === 'target_final'
    ) {
      if (
        !direction ||
        typeof data.text !== 'string' ||
        data.text.length > 20000 ||
        (data.stash !== undefined &&
          (typeof data.stash !== 'string' || data.stash.length > 20000)) ||
        typeof data.item_id !== 'string' ||
        data.item_id.length > 128 ||
        typeof data.response_id !== 'string' ||
        data.response_id.length > 128
      )
        return
    } else return
    return data
  } catch {
    return
  }
}

export function updateTranslationRows(
  rows: TranslationRow[],
  event: TranslationEvent
) {
  if (event.type !== 'target_candidate' && event.type !== 'target_final')
    return rows
  const id = `${event.direction}:${event.response_id}:${event.item_id}`
  const existing = rows.find((row) => row.id === id)
  if (existing?.final) return rows
  const row: TranslationRow = {
    id,
    direction: event.direction!,
    text: event.text!,
    stash: event.stash ?? '',
    final: event.type === 'target_final',
  }
  return (
    existing ? rows.map((old) => (old.id === id ? row : old)) : [...rows, row]
  ).slice(-60)
}
