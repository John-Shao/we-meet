import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import * as client from './client'
import { OPERATIONS } from './generated/r0a-client.mjs'

/**
 * C07(b) is only worth having if the generated surface and the shipped surface stay the same size.
 * The route-level drift gate (test/go-surface-drift.test.mjs) compares Go handlers against the
 * contract; nothing compared the contract against the functions the UI can actually call, which is
 * how five provider operations ended up with no consumer at all (task #26). This is that check.
 *
 * Every declared operation is either reachable from a named export or listed as uncalled with a
 * reason, and every exported function is accounted for in one of those two ways, so a new export
 * that targets nothing and a removed export that still has a declared operation both fail here.
 */

// Not call-layer members: the module's error type and two helpers the components use directly.
const NON_TRANSPORT_EXPORTS = ['WorkApiError', 'setWorkCSRFToken']

// Deep links the contract does not declare. go-surface-drift.test.mjs keeps them visible as
// IMPLEMENTED_ONLY, so they are hand-owned here on purpose rather than missing from the map below.
const HAND_OWNED_DEEP_LINKS = [
  'fetchWorkArtifactWorkspace',
  'fetchWorkArtifactContent',
  'workTaskArtifactContentUrl',
]

// operationId -> the export that calls it, or null with the reason it is not called.
const OPERATION_TO_EXPORT: Record<string, string | null> = {
  getBootstrap: 'fetchWorkBootstrap',
  createInput: 'createWorkInput',
  listTemplates: 'fetchWorkTemplates',
  createTaskPreview: 'createWorkPreview',
  listTasks: 'fetchWorkTasks',
  submitTask: 'submitWorkTask',
  getTask: 'fetchWorkTask',
  updateTask: 'updateWorkTaskTitle',
  deleteTask: 'deleteWorkTask',
  retryTask: 'retryWorkTask',
  // The run detail screen shows its operations ledger, not the run object itself.
  getRun: null,
  listOperations: 'fetchWorkRunOperations',
  cancelRun: 'cancelWorkRun',
  streamTaskEvents: 'openWorkEventStream',
  listInbox: 'fetchWorkInbox',
  createArtifactVersion: 'createWorkArtifactVersion',
  // Version metadata comes with the workspace projection; only the content is fetched per version.
  getArtifactVersion: null,
  // The UI reads content through the task-scoped deep link, which also enforces the task boundary.
  getArtifactContent: null,
  acceptTask: 'acceptWorkTask',
  // Own usage is shown on the admin page for the organization, not per subject.
  getUserUsage: null,
  getAdminUsage: 'fetchAdminUsage',
  getProviderConfig: 'fetchAdminProviderConfig',
  setProviderConfig: 'setAdminProviderConfig',
  revokeProviderConfig: 'revokeAdminProviderConfig',
  createProviderCredential: 'createAdminProviderCredential',
  rotateProviderCredential: 'rotateAdminProviderCredential',
  revokeProviderCredential: 'revokeAdminProviderCredential',
  getAdminOverview: 'fetchAdminOverview',
  listSeats: 'fetchAdminSeats',
  createAuditExport: 'createAdminAuditExport',
  getAuditExport: 'fetchAdminAuditExport',
  createAuditExportTicket: 'createAdminAuditExportTicket',
  getAuditExportContent: 'downloadAdminAuditExport',
}

describe('Work API client surface against the contract', () => {
  it('reaches every declared operation or records why it is not called', () => {
    expect(OPERATIONS.length).toBe(33)
    const declared = OPERATIONS.map((operation) => operation.operationId)
    expect(Object.keys(OPERATION_TO_EXPORT).sort()).toEqual(
      [...declared].sort()
    )

    const uncalled = declared.filter((id) => OPERATION_TO_EXPORT[id] === null)
    expect(uncalled).toEqual([
      'getRun',
      'getArtifactVersion',
      'getArtifactContent',
      'getUserUsage',
    ])
  })

  it('calls a declared operation for every exported function', () => {
    const exported = Object.keys(client).sort()
    const mapped = Object.values(OPERATION_TO_EXPORT).filter(
      (name): name is string => name !== null
    )
    const expected = [
      ...mapped,
      ...HAND_OWNED_DEEP_LINKS,
      ...NON_TRANSPORT_EXPORTS,
    ]
    expect(exported).toEqual([...expected].sort())

    for (const name of expected) {
      expect(typeof client[name as keyof typeof client]).toBe('function')
    }
  })

  it('keeps hand-written request paths to the two documented deep links', () => {
    // Everything that goes through the generated client resolves its path from OPERATIONS, so a new
    // literal in this file means a call site bypassed the contract again - the exact regression
    // C07(b) exists to prevent, and the reason it must be a failure rather than a review habit.
    // vitest gives jsdom modules an http import.meta.url, so locate the source from the
    // package root, which is where `npm test` runs.
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/features/work/r0a/api/client.ts'),
      'utf8'
    )
    const literals = [...source.matchAll(/'(\/work\/v1[^']*)'/g)].map(
      (match) => match[1]
    )
    expect([...literals].sort()).toEqual(
      [
        '/work/v1/tasks/{taskId}/artifacts/{artifactId}',
        '/work/v1/tasks/{taskId}/artifacts/{artifactId}/versions/{versionNo}/content',
      ].sort()
    )
  })
})
