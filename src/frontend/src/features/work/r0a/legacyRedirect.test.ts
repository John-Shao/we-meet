import { describe, expect, it } from 'vitest'

import { legacyWorkRedirect } from './legacyRedirect'

// D5 §14 requires that an old `/work?task=` link lands on the read-only history
// notice instead of opening or mapping a new task, and §13.10 asks specifically for a
// new-vs-old route isolation check. ArchivePage.test.tsx covers what the notice does
// once it is reached; this covers the mapping itself - including that a `task` or
// `view` parameter on a newer route is left to that route.
describe('legacyWorkRedirect', () => {
  it('sends an old task link to the read-only history notice', () => {
    expect(
      legacyWorkRedirect('/work', new URLSearchParams({ task: 'old-1' }))
    ).toBe('/work/archive?legacyTask=old-1')
    expect(
      legacyWorkRedirect('/work', new URLSearchParams({ task: 'a b&c' }))
    ).toBe('/work/archive?legacyTask=a%20b%26c')
  })

  it('maps the old view values onto the new routes', () => {
    expect(
      legacyWorkRedirect('/work', new URLSearchParams({ view: 'new' }))
    ).toBe('/work/new')
    expect(
      legacyWorkRedirect('/work', new URLSearchParams({ view: 'history' }))
    ).toBe('/work/archive')
    expect(
      legacyWorkRedirect(
        '/work',
        new URLSearchParams({ view: 'awaiting_acceptance' })
      )
    ).toBe('/work/items?view=awaiting_acceptance')
  })

  it('drops an unknown view instead of forwarding it to the list', () => {
    expect(
      legacyWorkRedirect('/work', new URLSearchParams({ view: 'office_agent' }))
    ).toBe('/work/items')
  })

  it('prefers the task link when an old URL carries both parameters', () => {
    expect(
      legacyWorkRedirect(
        '/work',
        new URLSearchParams({ task: 'old-1', view: 'all' })
      )
    ).toBe('/work/archive?legacyTask=old-1')
  })

  it('leaves the new home and every newer route alone', () => {
    expect(legacyWorkRedirect('/work', new URLSearchParams())).toBeNull()
    // The isolation half: these parameters belong to the route that carries them,
    // so re-reading them as legacy links would hijack the new pages.
    expect(
      legacyWorkRedirect('/work/items', new URLSearchParams({ view: 'all' }))
    ).toBeNull()
    expect(
      legacyWorkRedirect('/work/new', new URLSearchParams({ task: 'x' }))
    ).toBeNull()
    expect(
      legacyWorkRedirect(
        '/work/archive',
        new URLSearchParams({ legacyTask: 'x' })
      )
    ).toBeNull()
  })
})
