import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorkServer } from '../work-r0a-design-2026-10-25/mock-server.mjs';
import {
  canTransition,
  computeMetrics,
  emittedEventTypes,
  evaluateGoldenRun,
  evaluateGoldenSuite,
  loadPilot,
  validateCutover,
  validateGolden,
  validateMetrics,
} from './pilot-ops.mjs';

const pilot = loadPilot();
const schema = fs.readFileSync(
  new URL('../work-r0a-design-2026-10-25/r0a-schema-draft.sql', import.meta.url),
  'utf8',
);
const templates = createWorkServer().state.templates;

test('golden tasks cover every R0a template and match template sections', () => {
  assert.deepEqual(validateGolden(pilot.golden, templates), []);
  const drifted = structuredClone(pilot.golden);
  drifted.tasks[0].required_sections = ['背景'];
  drifted.tasks[1].goal = '参考 https://example.com';
  const errors = validateGolden(drifted, templates);
  assert.ok(errors.some((e) => e.includes('G01 sections drift')));
  assert.ok(errors.some((e) => e.includes('G02 goal must be synthetic')));
});

test('deterministic golden checks pass a good draft and flag a bad one', () => {
  const task = pilot.golden.tasks.find((t) => t.id === 'G03');
  const good = `## 目标\n季度培训覆盖全部新人。\n## 步骤\n1. 确认名单\n2. 排期\n${'说明'.repeat(200)}\n## 依赖\n场地。\n## 验收\n完成率≥90%。\n`;
  const result = evaluateGoldenRun(task, good);
  assert.equal(result.passed, true);
  assert.deepEqual(result.manual, ['no_named_people']);
  const bad = '## 目标\n见 https://x.example\n';
  const badResult = evaluateGoldenRun(task, bad);
  assert.deepEqual(badResult.failed.sort(), ['length_in_range', 'sections_present', 'steps_numbered']);
});

test('golden suite needs 2/3 passing runs per task, 80% of tasks and p95 latency', () => {
  const runs = pilot.golden.tasks.flatMap((t, i) => [
    { taskId: t.id, passed: true, costCents: 50, endToEndSeconds: 60 },
    { taskId: t.id, passed: i !== 0, costCents: 50, endToEndSeconds: 90 },
    { taskId: t.id, passed: i > 1, costCents: 50, endToEndSeconds: 120 },
  ]);
  const suite = evaluateGoldenSuite(pilot.golden, runs);
  assert.equal(suite.perTask.find((t) => t.id === 'G01').passed, false);
  assert.ok(suite.passRatio >= 0.8);
  assert.equal(suite.passed, true);
  const slow = evaluateGoldenSuite(pilot.golden, runs.map((r) => ({ ...r, endToEndSeconds: 400 })));
  assert.equal(slow.passed, false);
  const pricey = evaluateGoldenSuite(pilot.golden, runs.map((r) => ({ ...r, costCents: 999 })));
  assert.equal(pricey.passRatio, 0);
});

test('every metric event type is actually emitted by the D1 schema', () => {
  const emitted = emittedEventTypes(schema);
  for (const type of ['run.succeeded', 'task.awaiting_acceptance', 'task.completed', 'task.deleted']) {
    assert.ok(emitted.has(type), type);
  }
  assert.deepEqual(validateMetrics(pilot.metrics, emitted), []);
  const broken = structuredClone(pilot.metrics);
  broken.event_types.push('task.accepted');
  assert.deepEqual(validateMetrics(broken, emitted), ['event task.accepted is not emitted by D1']);
});

test('pilot metrics compute from content-free events', () => {
  const t0 = Date.UTC(2026, 10, 1);
  const ev = (type, taskId, at, extra = {}) => ({ org_id: 'org1', task_id: taskId, type, at: t0 + at * 1000, ...extra });
  const events = [
    ev('task.submitted', 'a', 10, { subject_id: 'u1' }),
    ev('task.submitted', 'b', 20, { subject_id: 'u2' }),
    ev('task.submitted', 'c', 30, { subject_id: 'u3' }),
    ev('task.submitted', 'd', 15 * 86400, { subject_id: 'u4' }),
    ev('artifact.published', 'a', 70),
    ev('artifact.published', 'b', 200),
    ev('run.succeeded', 'a', 80),
    ev('run.succeeded', 'b', 210),
    ev('run.failed', 'c', 40),
    ev('run.canceled', 'd', 15 * 86400 + 5),
    ev('task.awaiting_acceptance', 'a', 81),
    ev('task.awaiting_acceptance', 'b', 211),
    ev('task.completed', 'a', 300, { payload: { basis: 'version' } }),
    ev('task.completed', 'b', 400, { payload: { basis: 'reason' } }),
  ];
  const m = computeMetrics(events, { enabledAt: t0 });
  assert.equal(m.activated, true);
  assert.equal(m.activators, 3);
  assert.equal(m.technicalSuccessRate, 2 / 3);
  assert.equal(m.acceptanceRate, 0.5);
  assert.equal(m.reasonCompletionShare, 0.5);
  assert.equal(m.timeToFirstArtifactP50Seconds, 120);
});

test('cutover plan is consistent with the checklist and forbids dual-write', () => {
  assert.deepEqual(validateCutover(pilot.cutover, pilot.checklist), []);
  const gate = canTransition(pilot.cutover, pilot.checklist, 'off', 'pilot_on');
  assert.equal(gate.allowed, true);
  // 2026-11-09 续二: C27/C30 flipped done (DR3 12-01 回退条件), so the enable transition
  // is no longer blocked. gate.missing is empty; the mutation test below still works because
  // validateCutover checks blocking+category regardless of status.
  assert.deepEqual(gate.missing, []);
  assert.equal(canTransition(pilot.cutover, pilot.checklist, 'pilot_on', 'rolled_back').allowed, true);
  assert.equal(canTransition(pilot.cutover, pilot.checklist, 'off', 'rolled_back').allowed, false);

  const bad = structuredClone(pilot.cutover);
  bad.transitions[1].requires_checklist = ['C17'];
  bad.transitions[0].requires_checklist = bad.transitions[0].requires_checklist.filter((id) => id !== 'C30');
  bad.forbidden = [];
  const errors = validateCutover(bad, pilot.checklist);
  assert.ok(errors.includes('rollback must not wait on checklist'));
  assert.ok(errors.includes('enable transition misses blocking migration item C30'));
  assert.ok(errors.includes('dual-write must be forbidden'));
});

const metricsSql = fs.readFileSync(
  new URL('../../../../src/work/scripts/pilot-metrics.sql', import.meta.url),
  'utf8',
);

test('continued_after_acceptance counts only activity after the acceptance row itself', () => {
  const t0 = Date.UTC(2026, 10, 1);
  // seq is what the database orders by (unique per task, strictly increasing); at is the fallback.
  const ev = (type, taskId, seq, seconds, extra = {}) => ({
    org_id: 'org1',
    task_id: taskId,
    type,
    seq,
    at: t0 + seconds * 1000,
    ...extra,
  });
  const events = [
    // a: accepted, then renamed -> continuation.
    ev('task.submitted', 'a', 1, 10, { subject_id: 'u1' }),
    ev('artifact.published', 'a', 2, 60),
    ev('task.awaiting_acceptance', 'a', 3, 61),
    ev('task.completed', 'a', 4, 70, { payload: { basis: 'version' } }),
    ev('task.title_update', 'a', 5, 80),
    // b: renamed BEFORE accepting -> not continuation, however busy the task looks.
    ev('task.submitted', 'b', 1, 10, { subject_id: 'u2' }),
    ev('task.title_update', 'b', 2, 20),
    ev('artifact.published', 'b', 3, 60),
    ev('task.completed', 'b', 4, 70, { payload: { basis: 'version' } }),
    // c: accepted with nothing afterwards -> the denominator only.
    ev('task.submitted', 'c', 1, 10, { subject_id: 'u3' }),
    ev('task.awaiting_acceptance', 'c', 2, 40),
    ev('task.completed', 'c', 3, 50, { payload: { basis: 'version' } }),
  ];
  const m = computeMetrics(events, { enabledAt: t0 });
  assert.equal(m.continuedAfterAcceptanceCount, 1, 'only task a continues after its acceptance');
  assert.equal(m.continuedAfterAcceptance, 1 / 3);
  assert.equal(m.artifactSuccessRate, 2 / 3, 'a and b published a result, c did not');

  // Without the seq comparison the pre-acceptance edit would be counted, so the metric would read
  // 2/3 instead of 1/3. Dropping seq from the events exercises that fallback path.
  const timestampedOnly = events.map(({ seq, ...rest }) => rest);
  assert.equal(
    computeMetrics(timestampedOnly, { enabledAt: t0 }).continuedAfterAcceptanceCount,
    1,
    'the at-based fallback must agree with seq for this fixture',
  );
});

test('the SQL producer and pilot-metrics.json name the same metrics', () => {
  const sqlNames = [...metricsSql.matchAll(/^\s*SELECT '([a-z0-9_]+)'/gm)].map((match) => match[1]).sort();
  // golden_suite_pass_ratio comes from golden-tasks.json, not from events, so the SQL does not emit it.
  const jsonNames = Object.keys(pilot.metrics.metrics)
    .filter((name) => name !== 'golden_suite_pass_ratio')
    .sort();
  assert.deepEqual(sqlNames, jsonNames, 'a metric defined in one place and not the other drifts silently');
  for (const name of ['activation', 'continued_after_acceptance', 'acceptance_rate']) {
    assert.ok(sqlNames.includes(name), name);
  }
});
