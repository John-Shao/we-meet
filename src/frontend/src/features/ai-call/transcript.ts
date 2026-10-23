export type TranscriptRow = { createdAt?: number }

export type TranscriptEntry<T extends TranscriptRow> =
  | { kind: 'row'; at: number; row: T }
  | { kind: 'read'; at: number }

/**
 * The screen-read card belongs to the moment it was produced, not the end of
 * the list: later questions and answers must keep appearing below it.
 */
export function mergeTranscript<T extends TranscriptRow>(
  rows: T[],
  readAt: number | null
): TranscriptEntry<T>[] {
  const entries: TranscriptEntry<T>[] = rows.map((row) => ({
    kind: 'row',
    at: row.createdAt ?? 0,
    row,
  }))
  if (readAt !== null)
    entries.push({ kind: 'read', at: readAt || Number.MAX_SAFE_INTEGER })
  return entries.sort((a, b) => a.at - b.at)
}
