import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadOpsAssets,
  validateControls,
  validateSlo,
  validateChecklist,
  goNoGo,
} from './ops-model.mjs';
import {
  DEFAULT_INPUTS,
  DEFAULT_LIMITS,
  computeCapacity,
  evaluateCapacity,
} from './pilot-capacity-model.mjs';

const { controls, slo, checklist } = loadOpsAssets();

test('security controls have owners, close conditions and consistent status', () => {
  assert.deepEqual(validateControls(controls), []);
  assert.ok(controls.controls.some((item) => item.id === 'S16' && item.status === 'out_of_scope'));
  const broken = structuredClone(controls);
  broken.controls[0].status = 'closed';
  broken.controls[0].evidence = [];
  assert.ok(validateControls(broken).some((issue) => issue.includes('closed without evidence')));
});

test('SLO assets define required metrics and do not claim unmeasured results', () => {
  assert.deepEqual(validateSlo(slo), []);
  const broken = structuredClone(slo);
  broken.metrics[0].status = 'met';
  broken.metrics[0].evidence = [];
  assert.ok(validateSlo(broken).some((issue) => issue.includes('without evidence')));
  const missing = structuredClone(slo);
  missing.metrics = missing.metrics.filter((metric) => metric.id !== 'unknown_age_p95_min');
  assert.ok(validateSlo(missing).some((issue) => issue.includes('missing required SLO metric')));
});

test('pilot checklist is valid and currently blocked', () => {
  assert.deepEqual(validateChecklist(checklist), []);
  const result = goNoGo(checklist);
  assert.equal(result.go, false);
  assert.ok(result.blockerCount > 0);
  assert.ok(result.blockers.every((item) => item.owner));
});

test('pilot go/no-go becomes true only when every blocking item is done or waived', () => {
  const done = structuredClone(checklist);
  for (const item of done.items) {
    if (item.blocking) {
      item.status = 'done';
      item.evidence = ['drill/test evidence'];
    }
  }
  assert.deepEqual(validateChecklist(done), []);
  assert.equal(goNoGo(done).go, true);
});

test('pilot capacity baseline fits the current limits', () => {
  const capacity = computeCapacity(DEFAULT_INPUTS);
  assert.equal(capacity.tasksPerDay, 30);
  assert.equal(capacity.runsPerDay, 36);
  assert.equal(capacity.modelOpsPerDay, 108);
  assert.equal(capacity.providerPeakRpm, 7.5);
  assert.equal(capacity.tokensPerDay, 1_296_000);
  assert.ok(Math.abs(capacity.contentRetentionGb - 1.15632) < 0.001);
  const evaluated = evaluateCapacity(DEFAULT_INPUTS, DEFAULT_LIMITS);
  assert.equal(evaluated.ok, true);
  assert.ok(evaluated.checks.every((check) => check.pass));
});

test('10x load fails provider RPM, tokens, workflow and retention limits', () => {
  const high = {
    ...DEFAULT_INPUTS,
    activeUsers: 150,
    seats: 200,
    peakConcurrency: 100,
  };
  const evaluated = evaluateCapacity(high, DEFAULT_LIMITS);
  assert.equal(evaluated.ok, false);
  const failed = new Set(evaluated.checks.filter((check) => !check.pass).map((check) => check.metric));
  assert.ok(failed.has('providerPeakRpm'));
  assert.ok(failed.has('providerTokensPerDay'));
  assert.ok(failed.has('workflowStartsPeakPerMinute'));
  assert.ok(failed.has('contentRetentionGb'));
});

test('zero usage is valid and stays within limits', () => {
  const zero = { ...DEFAULT_INPUTS, activeUsers: 0, peakConcurrency: 0 };
  const evaluated = evaluateCapacity(zero, DEFAULT_LIMITS);
  assert.equal(evaluated.metrics.runsPerDay, 0);
  assert.equal(evaluated.metrics.tokensPerDay, 0);
  assert.equal(evaluated.ok, true);
});

test('capacity inputs reject invalid seat/concurrency assumptions', () => {
  assert.throws(
    () => computeCapacity({ ...DEFAULT_INPUTS, activeUsers: 21 }),
    (error) => error.message.includes('activeUsers exceeds seats'),
  );
  assert.throws(
    () => computeCapacity({ ...DEFAULT_INPUTS, peakConcurrency: 21 }),
    (error) => error.message.includes('peakConcurrency exceeds seats'),
  );
  assert.throws(
    () => computeCapacity({ ...DEFAULT_INPUTS, avgRunMinutes: 0 }),
    (error) => error.message.includes('avgRunMinutes'),
  );
});
