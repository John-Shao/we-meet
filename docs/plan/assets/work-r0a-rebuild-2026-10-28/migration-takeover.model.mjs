// 迁移接管设计模型：判定基线核验、漂移拒绝、单写入者与切换/回退规则。
// 不连接数据库、不执行 SQL、不证明任何真实库可被接管。

export function runnerAdmission(policy, context) {
  if (context.role === 'application' && policy.serialization.applicationRoleMayMigrate === false) {
    return { proceed: false, code: 'application_role_cannot_migrate' };
  }
  if (policy.serialization.legacyAndNewRunnerBothWritable === false && context.legacyRunnerWritable === true) {
    return { proceed: false, code: 'dual_writer_forbidden' };
  }
  if (policy.serialization.advisoryLockRequired && context.advisoryLockHeld !== true) {
    return { proceed: false, code: 'advisory_lock_required' };
  }
  for (const role of policy.prerequisites.rolesMustExist) {
    const found = context.roles?.[role];
    if (found == null) return { proceed: false, code: 'role_missing', role };
    if (policy.prerequisites.rolesMustBeNologin && found.canLogin === true) {
      return { proceed: false, code: 'role_must_be_nologin', role };
    }
  }
  return { proceed: true };
}

export function takeoverDecision(policy, database, baseline) {
  if (database.empty === true) {
    return {
      plan: policy.takeover.emptyDatabase,
      replayFullSchema: true,
      ledger: policy.ledger.newLedgerTable,
    };
  }
  const drift = (policy.takeover.verifiedObjects ?? []).filter((kind) => database.verified?.[kind] !== true);
  if (drift.length > 0) {
    return { plan: policy.takeover.driftOutcome, drift, stamped: policy.takeover.stampWithoutVerification };
  }
  if (database.baselineChecksum !== baseline.checksum || database.baselineRevision !== baseline.revision) {
    return { plan: policy.takeover.driftOutcome, drift: ['baseline_checksum'], stamped: false };
  }
  return {
    plan: policy.takeover.existingDatabase,
    replayFullSchema: policy.takeover.replayFullSchemaOnExisting,
    adoptedFrom: policy.ledger.legacyLedgerTable,
    legacyRecordsKept: policy.ledger.legacyRecordsRetainedAsEvidence,
    ledger: policy.ledger.newLedgerTable,
  };
}

export function incrementOutcome(policy, applied, increment) {
  const previous = applied.find((row) => row.version === increment.version);
  if (previous != null) {
    if (previous.checksum !== increment.checksum) {
      return { apply: false, code: 'published_migration_modified' };
    }
    return { apply: false, code: 'already_applied', repeatIsNoop: policy.recovery.repeatRunIsNoop };
  }
  if (!policy.ledger.versionedChecksumRequired || typeof increment.checksum !== 'string' || increment.checksum.length === 0) {
    return { apply: false, code: 'checksum_required' };
  }
  const maxApplied = applied.reduce((max, row) => (row.version > max ? row.version : max), 0);
  if (increment.version <= maxApplied) return { apply: false, code: 'version_not_monotonic' };
  if (increment.transactional !== true && !increment.namedRecoveryProtocol) {
    return { apply: false, code: 'non_transactional_needs_protocol' };
  }
  return {
    apply: true,
    sameTransactionAsLedger: policy.ledger.ledgerAndIncrementSameTransaction && increment.transactional === true,
  };
}

export function concurrentRunner(policy, context) {
  if (!policy.serialization.singleWriterOnly) return { outcome: 'undefined' };
  return context.lockAcquired === true
    ? { outcome: 'apply' }
    : { outcome: policy.serialization.concurrentRunnerOutcome };
}

export function recoveryOption(policy, request) {
  if (request.kind === 'drop_schema') return { allowed: policy.recovery.dropSchemaProvided, code: 'destructive_rollback_not_provided' };
  if (request.kind === 'migrate_zero') return { allowed: policy.recovery.migrateZeroProvided, code: 'destructive_rollback_not_provided' };
  if (request.kind === 'restore_backup') {
    return { allowed: request.rehearsed === true, code: request.rehearsed === true ? null : 'restore_requires_rehearsal' };
  }
  if (request.kind === 'forward_fix') return { allowed: policy.recovery.forwardFixOnly, code: null };
  return { allowed: false, code: 'unknown_recovery_kind' };
}

export function cutoverStep(policy, state) {
  if (state.regressionGreen !== true) return { proceed: false, code: 'regression_required' };
  if (state.legacyExecutionsDrained !== true) {
    return { proceed: false, code: policy.cutover.legacyWorkflowsDrainedNotKilled ? 'await_drain' : 'kill_allowed' };
  }
  return {
    proceed: true,
    switchRouting: policy.cutover.routingSwitchAfterGreenRegression,
    removeHostReferences: policy.cutover.hostReferencesRemovedPerModule,
    retentionContinues: policy.cutover.retentionAndReconciliationContinueDuringCutover,
  };
}

export function rollbackPlan(policy, build) {
  if (build.schemaCompatible !== true) return { allowed: false, code: 'incompatible_build' };
  return {
    allowed: true,
    restoresDualExecution: policy.cutover.rollbackRestoresDualExecution,
    replaysPaidRequests: policy.cutover.rollbackReplaysPaidRequests,
    rollsBackDatabase: false,
  };
}
