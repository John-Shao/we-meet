import { describe, expect, it } from 'vitest'

import * as client from './client'
import { OPERATIONS } from './generated/r0b-client.mjs'

/**
 * The R0a twin of this test compares the generated surface with the exports the UI can call;
 * this is the R0b half of the same check. The contract gate (docs/plan/assets/
 * work-r0b-browser-2026-11-23/test/browser-contract.test.mjs) pins the contract to the Go
 * router and to the frontend copies, and this test closes the last gap: no operation without
 * a named consumer, and no consumer that targets nothing.
 */
const OPERATION_TO_EXPORT = {
  getRunReconciliations: 'fetchWorkRunReconciliations',
  getRunHistoryHandback: 'fetchWorkRunHistoryHandback',
  getAdminLocalPolicy: 'fetchWorkLocalPolicy',
  setAdminLocalPolicy: 'setWorkLocalPolicy',
  listReadonlyGrants: 'fetchWorkReadonlyGrants',
  revokeReadonlyGrant: 'revokeWorkReadonlyGrant',
}

const transports = () =>
  Object.entries(client)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .sort()

describe('R0b browser client surface against the contract', () => {
  it('leaves no contract operation without a named consumer', () => {
    for (const operation of OPERATIONS) {
      const exported =
        OPERATION_TO_EXPORT[
          operation.operationId as keyof typeof OPERATION_TO_EXPORT
        ]
      expect(exported, operation.operationId).toBeTruthy()
      expect(typeof (client as Record<string, unknown>)[exported]).toBe(
        'function'
      )
    }
  })

  it('accounts for every transport export', () => {
    expect(transports()).toEqual(Object.values(OPERATION_TO_EXPORT).sort())
  })

  it('keeps the operation set frozen at the browser faces', () => {
    expect(OPERATIONS.map((operation) => operation.operationId).sort()).toEqual(
      Object.keys(OPERATION_TO_EXPORT).sort()
    )
  })
})
