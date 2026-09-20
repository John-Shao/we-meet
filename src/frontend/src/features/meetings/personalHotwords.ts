export type PersonalVocabulary = { words: string[]; revision: number }

// eslint-disable-next-line no-control-regex -- Match Python str.splitlines(), including record separators.
const lineBreaks = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/

/** Same order and exact-case de-duplication as the server; never drop overflow. */
export function mergeHotwords(current: string, saved: string[]): string {
  const words = [
    ...new Set(
      [...current.split(lineBreaks), ...saved]
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  ]
  const text = words.join('\n')
  if (
    words.length > 100 ||
    words.some((x) => [...x].length > 40) ||
    [...text].length > 4000
  )
    throw new Error('hotwords_too_large')
  return text
}

export function validateVocabulary(
  value: PersonalVocabulary
): PersonalVocabulary {
  if (
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.words) ||
    value.words.some(
      (x) => typeof x !== 'string' || !x.trim() || lineBreaks.test(x)
    ) ||
    mergeHotwords('', value.words) !== value.words.join('\n')
  )
    throw new Error('Invalid vocabulary')
  return value
}
