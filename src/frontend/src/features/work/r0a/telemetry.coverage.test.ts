import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { WORK_EVENTS } from './telemetry'

// D5 §10 declares nine events. telemetry.test.ts pins the declared set and the payload
// rules, but nothing there fails if a call site disappears - a declared-but-never-emitted
// event would pass every existing assertion while contributing no series. That drift is
// exactly how "artifact_save is not wired" lived in the pilot checklist after it had been
// shipped. This guard makes the list a contract with a consumer: every declared event must
// be called from at least one production file.
const featureDir = dirname(fileURLToPath(import.meta.url))

function* listSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* listSources(path)
    else if (/\.tsx?$/.test(entry.name)) yield path
  }
}

// telemetry.ts only declares the names, and *.test.* files call events to exercise the
// module - neither is a production wiring, so both are excluded or the guard is vacuous.
const productionSources = [...listSources(featureDir)]
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .filter((path) => path !== join(featureDir, 'telemetry.ts'))
  .map((path) => readFileSync(path, 'utf8'))

describe('WORK_EVENTS wiring', () => {
  it('has production sources to scan at all', () => {
    // If the scan ever finds no files the per-event cases below would pass vacuously.
    expect(productionSources.length).toBeGreaterThan(0)
  })

  it.each([...WORK_EVENTS])(
    '%s is emitted from a production call site',
    (name) => {
      const called = productionSources.some((source) =>
        new RegExp(`trackWorkEvent\\(\\s*['"]${name}['"]`).test(source)
      )
      expect(called, `no production trackWorkEvent('${name}') call site`).toBe(
        true
      )
    }
  )
})
