import { describe, expect, it } from 'vitest'

import deWork from '@/locales/de/work.json'
import enWork from '@/locales/en/work.json'
import frWork from '@/locales/fr/work.json'
import nlWork from '@/locales/nl/work.json'
import zhWork from '@/locales/zh/work.json'

// The Work UI resolves every string through one namespace per locale. react-i18next
// silently falls back to English when a key is absent, so a key added to en but not to
// the others still "renders" - which is how the #30 error keys could ship in en alone and
// leak untranslated text in fr/nl/de without any assertion noticing. This pins the shape:
// every locale must carry exactly the en Work key set. Scoped to work.json on purpose -
// other namespaces may lag intentionally and are not this suite's contract.
const flatten = (value: unknown, path = '', acc: string[] = []): string[] => {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, path ? `${path}.${key}` : key, acc)
    }
  } else {
    acc.push(path)
  }
  return acc.sort()
}

const enKeys = flatten(enWork)

describe('work locale parity', () => {
  it('en is non-empty (guards a vacuous pass)', () => {
    expect(enKeys.length).toBeGreaterThan(0)
  })

  const locales = { zh: zhWork, fr: frWork, nl: nlWork, de: deWork }
  for (const [name, bundle] of Object.entries(locales)) {
    it(`${name} carries exactly the en key set`, () => {
      expect(flatten(bundle)).toEqual(enKeys)
    })
  }
})
