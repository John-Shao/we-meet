import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import deWork from '@/locales/de/work.json'
import enWork from '@/locales/en/work.json'
import frWork from '@/locales/fr/work.json'
import nlWork from '@/locales/nl/work.json'
import zhWork from '@/locales/zh/work.json'

import { WorkApiError, workErrorMessage } from './api/client'

/**
 * D5 §7 (docs/plan/work-r0a-frontend-design-2026-10-25.md:266) promised dedicated copy for
 * `artifact_read_only` plus the eight admin/export codes. Until #30 A that sentence was false:
 * none of those codes appeared anywhere in the frontend and all of them fell through to
 * `errors.generic`. This keeps the promise honest - and reads the copy choice off
 * `workErrorMessage` itself rather than an internal table, so the observable surface is what
 * is pinned and no new module export is added.
 */

// The contract classifies 60 codes with a `ui` column, but the Error payload carries only
// code/message/retryable/correlation_id/current_revision/recovery_action (additionalProperties
// false), so `ui` is a contract-side authoring aid and cannot be the frontend's copy anchor.
const contract = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), '../../src/work/contracts/error-codes.json'),
    'utf8'
  )
) as { public: Record<string, unknown> }

const CONTRACT_CODES = Object.keys(contract.public)

const keyFor = (code: string): string =>
  workErrorMessage(
    new WorkApiError(400, { code, message: '服务端固定的中文文案' })
  )

// What the contract says D5 names, independent of the frontend.
const EXPECTED_DEDICATED = CONTRACT_CODES.filter(
  (code) =>
    /^(admin_|audit_export_|download_token_)/.test(code) ||
    code === 'artifact_read_only' ||
    code === 'resync_required'
).sort()

// What the frontend actually does with each declared code.
const ACTUAL_DEDICATED = CONTRACT_CODES.filter(
  (code) => keyFor(code) !== 'errors.generic'
).sort()

const CATALOGS: Record<string, Record<string, string>> = {
  de: (deWork as { errors: Record<string, string> }).errors,
  en: (enWork as { errors: Record<string, string> }).errors,
  fr: (frWork as { errors: Record<string, string> }).errors,
  nl: (nlWork as { errors: Record<string, string> }).errors,
  zh: (zhWork as { errors: Record<string, string> }).errors,
}

describe('D5 §7 error copy', () => {
  it('reads a real contract and a real locale set, so empties cannot pass', () => {
    expect(CONTRACT_CODES.length).toBeGreaterThanOrEqual(60)
    expect(EXPECTED_DEDICATED.length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(CATALOGS).length).toBe(5)
  })

  it('gives dedicated copy to exactly the codes D5 names', () => {
    expect(ACTUAL_DEDICATED).toEqual(EXPECTED_DEDICATED)
  })

  it('never renders the server message, which is fixed Chinese text', () => {
    for (const code of CONTRACT_CODES) {
      expect(keyFor(code)).toMatch(/^errors\./)
      expect(keyFor(code)).not.toContain('服务端')
    }
  })

  it('has every produced key in all five locales', () => {
    // One direction only: a key the mapping needs must exist. Untranslated extras elsewhere are
    // tolerated by design - that is why #42's bidirectional parity gate was rolled back
    // (eb4d5b03c), and re-building it here would recreate that false red.
    for (const [language, errors] of Object.entries(CATALOGS)) {
      const missing = CONTRACT_CODES.filter((code) => {
        const leaf = keyFor(code).split('.')[1]
        return typeof errors[leaf] !== 'string' || errors[leaf].length === 0
      })
      expect(missing, `${language}/work.json has no copy for`).toEqual([])
    }
  })

  it('keeps an unlisted code on the generic fallback', () => {
    const unlisted = new WorkApiError(409, {
      code: 'version_conflict',
      message: '版本已变更',
    })
    expect(workErrorMessage(unlisted)).toBe('errors.generic')
    expect(workErrorMessage(new Error('network'))).toBe('errors.generic')
    expect(workErrorMessage('a string')).toBe('errors.generic')
  })
})
