import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  concurrentRunner,
  cutoverStep,
  incrementOutcome,
  recoveryOption,
  rollbackPlan,
  runnerAdmission,
  takeoverDecision,
} from './migration-takeover.model.mjs';

const policy = JSON.parse(readFileSync(new URL('./migration-takeover.policy.json', import.meta.url), 'utf8'));
const roles = Object.fromEntries(policy.prerequisites.rolesMustExist.map((role) => [role, { canLogin: false }]));
const context = { role: 'migrator', advisoryLockHeld: true, legacyRunnerWritable: false, roles };
const baseline = { revision: 42, checksum: 'sha256:baseline' };
const verified = Object.fromEntries(policy.takeover.verifiedObjects.map((kind) => [kind, true]));
const existing = { empty: false, verified, baselineRevision: 42, baselineChecksum: 'sha256:baseline' };

test('the migration runner requires an advisory lock, NOLOGIN roles and no legacy writer', () => {
  assert.deepEqual(runnerAdmission(policy, context), { proceed: true });
  assert.equal(runnerAdmission(policy, { ...context, advisoryLockHeld: false }).code, 'advisory_lock_required');
  assert.equal(runnerAdmission(policy, { ...context, legacyRunnerWritable: true }).code, 'dual_writer_forbidden');
  assert.equal(runnerAdmission(policy, { ...context, role: 'application' }).code, 'application_role_cannot_migrate');
});

test('every required role must exist and must not be able to log in', () => {
  for (const role of policy.prerequisites.rolesMustExist) {
    const missing = { ...roles };
    delete missing[role];
    assert.equal(runnerAdmission(policy, { ...context, roles: missing }).code, 'role_missing');
    const login = { ...roles, [role]: { canLogin: true } };
    assert.equal(runnerAdmission(policy, { ...context, roles: login }).code, 'role_must_be_nologin');
  }
});

test('an empty database initializes the baseline while an existing one is verified and adopted', () => {
  const fresh = takeoverDecision(policy, { empty: true }, baseline);
  assert.equal(fresh.plan, 'initialize_baseline_then_increments');
  assert.equal(fresh.replayFullSchema, true);
  const adopted = takeoverDecision(policy, existing, baseline);
  assert.equal(adopted.plan, 'verify_then_adopt_then_increments_only');
  assert.equal(adopted.replayFullSchema, false);
  assert.equal(adopted.adoptedFrom, 'django_migrations');
  assert.equal(adopted.legacyRecordsKept, true);
  assert.equal(adopted.ledger, 'work.schema_migration');
});

test('any object, permission or checksum drift rejects the takeover with a diff instead of stamping', () => {
  for (const kind of policy.takeover.verifiedObjects) {
    const drifted = { ...existing, verified: { ...verified, [kind]: false } };
    const decision = takeoverDecision(policy, drifted, baseline);
    assert.equal(decision.plan, 'reject_with_diff');
    assert.deepEqual(decision.drift, [kind]);
    assert.equal(decision.stamped, false);
  }
  assert.deepEqual(takeoverDecision(policy, { ...existing, baselineChecksum: 'sha256:other' }, baseline).drift, ['baseline_checksum']);
  assert.deepEqual(takeoverDecision(policy, { ...existing, baselineRevision: 41 }, baseline).drift, ['baseline_checksum']);
});

test('increments are monotonic, checksummed and never rewrite a published migration', () => {
  const applied = [{ version: 42, checksum: 'sha256:baseline' }];
  const next = { version: 43, checksum: 'sha256:next', transactional: true };
  const outcome = incrementOutcome(policy, applied, next);
  assert.equal(outcome.apply, true);
  assert.equal(outcome.sameTransactionAsLedger, true);
  assert.equal(incrementOutcome(policy, applied, { ...next, version: 42 }).code, 'published_migration_modified');
  assert.equal(incrementOutcome(policy, applied, applied[0]).code, 'already_applied');
  assert.equal(incrementOutcome(policy, [...applied, next], { ...next, version: 43, checksum: 'sha256:next' }).code, 'already_applied');
  assert.equal(incrementOutcome(policy, applied, { ...next, version: 41 }).code, 'version_not_monotonic');
  assert.equal(incrementOutcome(policy, applied, { ...next, checksum: '' }).code, 'checksum_required');
});

test('a non transactional step needs a named recovery protocol before it may run', () => {
  const applied = [{ version: 42, checksum: 'sha256:baseline' }];
  const step = { version: 43, checksum: 'sha256:concurrent', transactional: false };
  assert.equal(incrementOutcome(policy, applied, step).code, 'non_transactional_needs_protocol');
  const named = incrementOutcome(policy, applied, { ...step, namedRecoveryProtocol: 'create_index_concurrently_resume' });
  assert.equal(named.apply, true);
  assert.equal(named.sameTransactionAsLedger, false);
  assert.equal(policy.recovery.nonTransactionalStepsNeedNamedProtocol, true);
});

test('a second runner waits on the lock and then becomes a no-op rather than reapplying', () => {
  assert.equal(concurrentRunner(policy, { lockAcquired: true }).outcome, 'apply');
  assert.equal(concurrentRunner(policy, { lockAcquired: false }).outcome, 'lock_wait_then_noop');
  assert.equal(policy.recovery.repeatRunIsNoop, true);
});

test('recovery is forward fix or a rehearsed restore, never a destructive rollback', () => {
  assert.equal(recoveryOption(policy, { kind: 'forward_fix' }).allowed, true);
  assert.equal(recoveryOption(policy, { kind: 'drop_schema' }).allowed, false);
  assert.equal(recoveryOption(policy, { kind: 'migrate_zero' }).code, 'destructive_rollback_not_provided');
  assert.equal(recoveryOption(policy, { kind: 'restore_backup', rehearsed: false }).code, 'restore_requires_rehearsal');
  assert.equal(recoveryOption(policy, { kind: 'restore_backup', rehearsed: true }).allowed, true);
  assert.equal(recoveryOption(policy, { kind: 'truncate' }).code, 'unknown_recovery_kind');
});

test('cutover waits for green regression and drained legacy executions', () => {
  assert.equal(cutoverStep(policy, { regressionGreen: false, legacyExecutionsDrained: true }).code, 'regression_required');
  assert.equal(cutoverStep(policy, { regressionGreen: true, legacyExecutionsDrained: false }).code, 'await_drain');
  const go = cutoverStep(policy, { regressionGreen: true, legacyExecutionsDrained: true });
  assert.equal(go.proceed, true);
  assert.equal(go.switchRouting, true);
  assert.equal(go.removeHostReferences, true);
  assert.equal(go.retentionContinues, true);
});

test('rollback only uses a schema compatible build and never revives dual execution or paid replays', () => {
  assert.equal(rollbackPlan(policy, { schemaCompatible: false }).code, 'incompatible_build');
  const plan = rollbackPlan(policy, { schemaCompatible: true });
  assert.equal(plan.allowed, true);
  assert.equal(plan.restoresDualExecution, false);
  assert.equal(plan.replaysPaidRequests, false);
  assert.equal(plan.rollsBackDatabase, false);
});

test('the takeover contract stays design-signed but unrehearsed', () => {
  assert.equal(policy.approval, 'design_signed');
  assert.equal(policy.evidence, 'design_model_only');
  assert.equal(policy.rehearsed, false);
  assert.equal(policy.takeover.replayFullSchemaOnExisting, false);
  assert.equal(policy.takeover.stampWithoutVerification, false);
  assert.equal(policy.ledger.publishedMigrationBodyImmutable, true);
});
