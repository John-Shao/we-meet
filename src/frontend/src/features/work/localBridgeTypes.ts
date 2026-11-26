// Type-only mirrors of the desktop preload bridge (`src/desktop/src/work/bridge.ts`).
// The frontend image builds with `src/frontend` as its context, so the renderer cannot
// import across trees; these copies must track the bridge payloads. Keep them in sync
// with the desktop interfaces of the same names.
export interface PendingLocalApproval {
  approvalId: string
  taskId: string
  runId: string
  operationId: string
  actionKind: string
  risk: string
  expiresAt: string
}

export interface LocalArtifactDraft {
  requestId: string
  versionId: string
  artifactId: string
  taskId: string
  baseVersionId: string
  baseVersionNo: number
  baseHash: string
  format: 'text/plain' | 'text/markdown'
  contentHash: string
  byteCount: number
  baseByteCount: number
  publishState: 'pending_confirm' | 'pending_publish' | 'expired'
  createdAt: number
}

export interface WorkspaceGrantSummary {
  grantId: string
  rootIdentityHash: string
  artifactDir: string[]
}
