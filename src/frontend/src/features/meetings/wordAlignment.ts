/// <reference lib="es2022.intl" />
import { useEffect, useState } from 'react'

export type WordToken = {
  start_offset: number
  end_offset: number
  start_ms: number
  end_ms: number
}
export type PlaybackAlignment = {
  status: string
  version?: number
  alignment_revision?: number
  time_basis?: string
  offset_unit?: string
  text_sha256?: string
  tokens?: WordToken[]
}

/** Validate untrusted enhancement data without making the transcript unreadable. */
export async function validateWords(
  text: string,
  data?: PlaybackAlignment
): Promise<WordToken[]> {
  if (
    data?.status !== 'available' ||
    data.version !== 1 ||
    data.time_basis !== 'segment_source' ||
    data.offset_unit !== 'utf16' ||
    !Array.isArray(data.tokens) ||
    !data.tokens.length ||
    data.tokens.length > 10000 ||
    !Number.isSafeInteger(data.alignment_revision) ||
    data.alignment_revision! < 1
  )
    return []
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    )
    const hash = Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, '0')
    ).join('')
    if (hash !== data.text_sha256) return []
    const boundaries = new Set<number>([text.length])
    for (const part of new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(text))
      boundaries.add(part.index)
    let offset = 0,
      end = 0
    for (const token of data.tokens) {
      if (
        !token ||
        ![
          token.start_offset,
          token.end_offset,
          token.start_ms,
          token.end_ms,
        ].every(Number.isSafeInteger) ||
        token.start_offset < offset ||
        token.end_offset <= token.start_offset ||
        token.end_offset > text.length ||
        token.start_ms < end ||
        token.end_ms <= token.start_ms ||
        !boundaries.has(token.start_offset) ||
        !boundaries.has(token.end_offset) ||
        /[^\p{P}\s]/u.test(text.slice(offset, token.start_offset))
      )
        return []
      offset = token.end_offset
      end = token.end_ms
    }
    return /[^\p{P}\s]/u.test(text.slice(offset)) ? [] : data.tokens
  } catch {
    return []
  }
}

export function activeWordIndex(
  tokens: readonly WordToken[],
  position?: number
): number {
  if (position === undefined || !Number.isFinite(position)) return -1
  let low = 0,
    high = tokens.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (tokens[mid].start_ms <= position) low = mid + 1
    else high = mid
  }
  return low > 0 && position < tokens[low - 1].end_ms ? low - 1 : -1
}

export function useWordAlignment(text: string, data?: PlaybackAlignment) {
  const [validated, setValidated] = useState<{
    text: string
    data?: PlaybackAlignment
    tokens: WordToken[]
  }>()
  useEffect(() => {
    let cancelled = false
    void validateWords(text, data).then((tokens) => {
      if (!cancelled) setValidated({ text, data, tokens })
    })
    return () => {
      cancelled = true
    }
  }, [text, data])
  // A correction invalidates the old ranges synchronously, before the effect runs.
  return validated?.text === text && validated.data === data
    ? validated.tokens
    : []
}
