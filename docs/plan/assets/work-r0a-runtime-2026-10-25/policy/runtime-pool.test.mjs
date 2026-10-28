import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  admissionDecision,
  drainDecision,
  effectiveMaxChildren,
  lateRequestAllowed,
  parentLossConsequence,
  podLimitSufficient,
  podMemoryBudgetMiB,
  reclaimPlan,
  requiresPerRunPod,
} from './runtime-pool.model.mjs';

const policy = JSON.parse(readFileSync(new URL('./runtime-pool.policy.json', import.meta.url), 'utf8'));

const node = {
  draining: false,
  cgroupDelegation: true,
  runningChildren: 0,
  podMemoryLimitMiB: podMemoryBudgetMiB(policy),
  freeMemoryMiB: 2048,
  freeScratchMiB: 1024,
  runtimeVersion: 'work-pi-1.4.0-build1',
};
const request = {
  runtimeVersion: 'work-pi-1.4.0-build1',
  checkpointRuntimeVersion: 'work-pi-1.4.0-build1',
  remainingBudgetMs: 900000,
  alreadyClaimed: false,
};

test('pod budget must cover every child plus parent reserve, scratch and overhead', () => {
  const expected = 256 + 128 + 2 * (1024 + 256);
  assert.equal(podMemoryBudgetMiB(policy), expected);
  assert.equal(podLimitSufficient(policy, expected), true);
  assert.equal(podLimitSufficient(policy, expected - 1), false);
  assert.equal(admissionDecision(policy, { ...node, podMemoryLimitMiB: expected - 1 }, request).code, 'pod_budget_insufficient');
});

test('without delegated cgroup subtrees the pool falls back to one child, not to best effort sharing', () => {
  assert.equal(effectiveMaxChildren(policy, node), 2);
  assert.equal(effectiveMaxChildren(policy, { ...node, cgroupDelegation: false }), 1);
  assert.equal(admissionDecision(policy, { ...node, cgroupDelegation: false, runningChildren: 1 }, request).code, 'pool_at_capacity');
});

test('admission happens before claiming the execution and rejects past local capacity', () => {
  assert.deepEqual(admissionDecision(policy, node, request), { admit: true, code: 'admit', stage: 'before_claim' });
  assert.equal(admissionDecision(policy, { ...node, runningChildren: 2 }, request).code, 'pool_at_capacity');
  assert.equal(admissionDecision(policy, node, { ...request, alreadyClaimed: true }).code, 'claim_before_admission_forbidden');
  assert.equal(policy.concurrency.rejectBeforeClaim, true);
  assert.equal(policy.concurrency.localAdmissionIsFinalGate, true);
});

test('missing memory, scratch or startup time is rejected rather than queued inside the pod', () => {
  assert.equal(admissionDecision(policy, { ...node, freeMemoryMiB: 512 }, request).code, 'insufficient_memory');
  assert.equal(admissionDecision(policy, { ...node, freeScratchMiB: 64 }, request).code, 'insufficient_scratch');
  assert.equal(admissionDecision(policy, node, { ...request, remainingBudgetMs: 10000 }).code, 'insufficient_time_budget');
  for (const broken of [{ runningChildren: -1 }, { runningChildren: 1.5 }]) {
    assert.equal(admissionDecision(policy, { ...node, ...broken }, request).code, 'unknown_local_state');
  }
  assert.equal(admissionDecision(policy, node, { ...request, remainingBudgetMs: null }).code, 'unknown_local_state');
});

test('rolling upgrade refuses mismatched runtime and incompatible checkpoints instead of guessing', () => {
  assert.equal(admissionDecision(policy, node, { ...request, runtimeVersion: 'work-pi-1.5.0-build1' }).code, 'runtime_version_mismatch');
  assert.equal(
    admissionDecision(policy, node, { ...request, checkpointRuntimeVersion: 'work-pi-1.3.0-build9' }).code,
    'incompatible_checkpoint_version',
  );
  assert.equal(policy.upgrade.executionBoundRuntimeVersion, true);
});

test('draining stops new fragments while still letting in-flight work renew and finish', () => {
  assert.equal(admissionDecision(policy, { ...node, draining: true }, request).code, 'pool_draining');
  const awaiting = drainDecision(policy, { inFlightChildren: 1, elapsedMs: 1000 });
  assert.equal(awaiting.action, 'await_in_flight');
  assert.equal(awaiting.acceptNewFragments, false);
  assert.equal(awaiting.allowRenew, true);
  assert.equal(awaiting.stopPollingFirst, true);
  assert.equal(drainDecision(policy, { inFlightChildren: 0, elapsedMs: 1000 }).action, 'exit');
  assert.equal(drainDecision(policy, { inFlightChildren: 1, elapsedMs: 960000 }).action, 'cancel_in_flight_then_reconcile');
});

test('a termination grace shorter than the drain window is reported as hard-kill risk, not as graceful', () => {
  assert.equal(drainDecision(policy, { inFlightChildren: 1, elapsedMs: 0 }).hardKillRisk, false);
  const tight = { ...policy, podBudget: { ...policy.podBudget, terminationGracePeriodSeconds: 30 } };
  assert.equal(drainDecision(tight, { inFlightChildren: 1, elapsedMs: 0 }).hardKillRisk, true);
  assert.equal(policy.drain.hardKillFallbackRequiresProductDisclosure, true);
});

test('local reclamation never concludes that nothing was sent', () => {
  const consumed = reclaimPlan(policy, { gateConsumed: true, cause: 'child_unresponsive' });
  assert.equal(consumed.fragmentResult, 'WAITING_RECONCILE');
  assert.equal(consumed.externalState, 'unknown_requires_reconcile');
  assert.equal(consumed.provesNotSent, false);
  const notConsumed = reclaimPlan(policy, { gateConsumed: false, cause: 'child_unresponsive' });
  assert.equal(notConsumed.fragmentResult, 'FAILED');
  assert.equal(notConsumed.externalState, 'requires_seal_to_prove_not_sent');
  assert.equal(notConsumed.reusesOldPermit, false);
  assert.equal(policy.reclamation.localReclaimProvesNotSent, false);
});

test('reclamation force-kills after the cancel grace and frees the slot, scratch and pipes', () => {
  const plan = reclaimPlan(policy, { gateConsumed: false, cause: 'deadline_exceeded' });
  assert.deepEqual(plan.localActions, [
    'send_cancel_frame',
    'force_kill_after_grace',
    'close_private_pipes',
    'remove_execution_scratch',
    'release_local_slot',
  ]);
  assert.equal(policy.reclamation.scratchPerExecution, true);
  assert.equal(policy.reclamation.staleScratchSweepOnStart, true);
});

test('child memory exhaustion is reported as a resource fault, not as a provider error', () => {
  assert.equal(reclaimPlan(policy, { gateConsumed: false, cause: 'memory_exhausted' }).reasonCode, 'resource_exhausted');
  assert.equal(reclaimPlan(policy, { gateConsumed: true, cause: 'memory_exhausted' }).externalState, 'unknown_requires_reconcile');
});

test('losing the parent terminates children and resolves only through Go revoke and reconcile', () => {
  const timedOut = parentLossConsequence(policy, { heartbeatTimedOut: true });
  assert.equal(timedOut.childSelfTerminates, true);
  assert.equal(timedOut.orphanCanObtainNewAuthorization, false);
  assert.equal(timedOut.recoverFromLocalResidue, false);
  assert.equal(timedOut.resolution, 'go_revoke_then_reconcile');
  assert.equal(timedOut.sameExecutionRestart, false);
  assert.equal(parentLossConsequence(policy, { heartbeatTimedOut: false }).resolution, 'await_heartbeat_timeout');
});

test('stale holders, generations, executions and late activity results are all refused', () => {
  assert.equal(lateRequestAllowed(policy, {}), true);
  for (const flag of ['staleHolder', 'staleGeneration', 'staleExecution', 'lateActivityResult']) {
    assert.equal(lateRequestAllowed(policy, { [flag]: true }), false);
    assert.equal(policy.lateFragment[`${flag}Allowed`] ?? policy.lateFragment.lateActivityResultAdvancesHead, false);
  }
});

test('per-Run Pods become mandatory on any signed hard gate, and a RuntimeClass is not isolation proof', () => {
  assert.equal(requiresPerRunPod(policy, {}), false);
  for (const gate of policy.upgrade.perRunPodHardGates) {
    assert.equal(requiresPerRunPod(policy, { [gate]: true }), true);
  }
  assert.equal(requiresPerRunPod(policy, { runtime_class_present: true }), false);
  assert.equal(policy.upgrade.runtimeClassAloneIsIsolationEvidence, false);
});

test('capacity and isolation remain unproven design constants with no child reuse or prewarm', () => {
  assert.equal(policy.approval, 'design_signed');
  assert.equal(policy.evidence, 'design_model_only');
  assert.equal(policy.loadTested, false);
  assert.equal(policy.sandboxProof, false);
  assert.equal(policy.observability.capacityNumbersSignedOff, false);
  assert.equal(policy.observability.highCardinalityIdentifiersInMetrics, false);
  assert.equal(policy.concurrency.prewarmChildren, false);
  assert.equal(policy.concurrency.reuseChildAcrossRuns, false);
  assert.equal(policy.podBudget.requestsEqualLimits, true);
});
