import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('blocking items split into a start gate and a pilot gate', () => {
  const result = goNoGo(checklist);
  assert.deepEqual(
    result.startBlockers.map((item) => item.id).sort(),
    ['C03', 'C04', 'C05', 'C25'],
  );
  assert.ok(!result.startBlockers.some((item) => item.id === 'C15'));
  assert.equal(checklist.items.find((item) => item.id === 'C15').status, 'waived');
  // C11 signs the S01-S18 mapping口径 only; control implementation evidence stays in the pilot gate.
  assert.equal(checklist.items.find((item) => item.id === 'C11').status, 'done');
  assert.equal(result.startBlockerCount, 4);
  assert.equal(result.pilotBlockerCount, 14);
  assert.equal(result.scaleBlockerCount, 0);
  assert.equal(result.canStartWork, false);
  assert.equal(result.blockerCount, result.startBlockerCount + result.pilotBlockerCount + result.scaleBlockerCount);

  // 关掉开工闸门只允许开工，不等于可以试点：14 个试点证据项仍必须由实施产生。
  const started = structuredClone(checklist);
  for (const item of started.items) {
    if (item.gate === 'start' && item.blocking) {
      item.status = 'done';
      item.evidence = ['review sign-off'];
    }
  }
  const afterStart = goNoGo(started);
  assert.equal(afterStart.canStartWork, true);
  assert.equal(afterStart.go, false);
  assert.equal(afterStart.pilotBlockerCount, 14);
});

test('checklist rejects a missing or unknown gate', () => {
  const noGate = structuredClone(checklist);
  delete noGate.items[0].gate;
  assert.ok(validateChecklist(noGate).some((issue) => issue.includes('invalid gate')));
  const badGate = structuredClone(checklist);
  badGate.items[0].gate = 'whenever';
  assert.ok(validateChecklist(badGate).some((issue) => issue.includes('invalid gate')));
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

test('S17/S18 cover the projection write path and the one-time export download', () => {
  const byId = new Map(controls.controls.map((item) => [item.id, item]));
  const s17 = byId.get('S17');
  const s18 = byId.get('S18');
  assert.ok(s17 && s18, 'both controls are registered');
  for (const [id, control] of [['S17', s17], ['S18', s18]]) {
    assert.equal(control.status, 'partial', id);
    assert.ok(control.closeCondition.length > 20, id);
    assert.ok(control.evidence.length >= 3, id);
  }
  assert.match(s17.control, /work_directory/);
  assert.match(s17.control, /projection_revision_stale/);
  assert.match(s18.control, /X-Download-Token/);
  assert.match(s18.control, /single-use/);
  // 正文/令牌都不进 URL：导出与成果契约里不得出现预签下载链接字段。
  const openapi = readFileSync(
    new URL('../work-r0a-design-2026-10-25/r0a-openapi-v1.yaml', import.meta.url), 'utf8',
  );
  assert.ok(!/download_url/.test(openapi));
});
