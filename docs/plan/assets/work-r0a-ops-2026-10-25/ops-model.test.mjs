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
  // 2026-11-01 闸门复审：C05（D5 前端设计）、C10（React 页面/查询/SSE E2E）、C31（管理只读面）
  // 已按生产证据关闭，开工闸门只剩设计评审与可用性研究；
  // C33（子进程 checkpoint 写入 content-proxy，决策单 #280）按 John 勾选的 B 记为书面范围例外。
  // 2026-11-09 reconciliation: both start-gate blockers are now closed - C04 by the D-08b
  // adjudication (`done` in the checklist) and C25 by the UT1-UT5 internal-pilot usability
  // evidence (see C25 evidence). The start gate is therefore clear.
  assert.deepEqual(
    result.startBlockers.map((item) => item.id).sort(),
    [],
  );
  assert.ok(!result.startBlockers.some((item) => item.id === 'C15'));
  assert.equal(checklist.items.find((item) => item.id === 'C15').status, 'waived');
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C33'));
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C10'), 'C10 closed with the retry affordance asserted');
  const c33 = checklist.items.find((item) => item.id === 'C33');
  assert.equal(c33.status, 'waived');
  assert.ok(c33.blocking, '#280 stays declared as an exit gate, closed by exception not by omission');
  // C11 signs the S01-S18 mapping口径 only; control implementation evidence stays in the pilot gate.
  assert.equal(checklist.items.find((item) => item.id === 'C11').status, 'done');
  assert.equal(result.startBlockerCount, 0);
  // 2026-11-04：C07 关闭（D2′ 重签完成，#45 八项签署、surfaceFrozen=true 在远端 blob 核到），
  // 试点闸门由 12 降到 11。名单仍逐项钉死，不是放宽。
  // 2026-11-04 深夜：C29 关闭——**不是自评**，而是旧 Work 冻结面签收单 §4 那句由主签逐字确认、
  // §6 预先写明「签了 → C29 done、未闭合从 14 降到 13」，署名记录在 work-r0a-legacy-freeze-signoff-2026-11-04.md。
  // 计数因此 11 → 10；被关的那一项点名如下，防止下次有人对着数字改状态。
  // 2026-11-08 主签逐条签字：C03（S1-3/S1-R06 改判 pass 后 §4(3) 成立）、C16（接受散文盲区为已知局限）、
  // C17（关闭条件改写为「库侧巡检＋邮件告警在现网生效」）、C22（§11 第 2 行 D3+D4 全 PASS）置 done，
  // 试点闸门 10 → 7。四项都由上面的状态数据推导，不在这里放宽任何闸门定义。
  // 2026-11-09 reconciliation: pilot blockers 7 -> 3. C28 closed this batch (cited the D4-a
  // end-to-end cutover timing); the remaining open set was C26/C27/C30. C24 was already
  // `done` from the pilot-org sign-off; C03/C16/C17/C22/C29 closed in the 11-04 / 11-08 passes.
  // 2026-11-09 续：C26 于本批内由 §7 M2 播种（真 Keycloak 登录 → 真 POST /work/v1/inputs → 真 run
  // → 真 awaiting_acceptance → 真采纳，三个不同 seated 提交者 03a7c56e／45a1a4ca／d662bc9c）＋
  // 窗口重锚到 2026-11-08T00:00:00Z 的 pilot-metrics.sql 只读重跑（psql exit 0，4 条 go_gate 全绿）
  // 关闭 ⇒ pilot blockers 3 -> 2，剩余开放集仅 C27／C30。
  assert.equal(result.pilotBlockerCount, 2);
  assert.deepEqual(
    result.pilotBlockers.map((item) => item.id).sort(),
    ['C27', 'C30'],
  );
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C03'));
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C16'));
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C17'));
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C22'));
  for (const id of ['C03', 'C16', 'C17', 'C22']) {
    assert.equal(checklist.items.find((item) => item.id === id).status, 'done', id);
  }
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C29'), 'C29 closed by the signed freeze sheet');
  assert.equal(checklist.items.find((item) => item.id === 'C29').status, 'done');
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C28'), 'C28 closed by citing the D4-a cutover timing');
  assert.equal(checklist.items.find((item) => item.id === 'C28').status, 'done');
  assert.ok(!result.pilotBlockers.some((item) => item.id === 'C26'), 'C26 closed by the 2026-11-09 §7 M2 seeding + pilot-metrics.sql re-run (4 go_gate green in the 11-08 window)');
  assert.equal(checklist.items.find((item) => item.id === 'C26').status, 'done');
  assert.equal(result.scaleBlockerCount, 0);
  // 2026-11-09: start gate is clear (C04 + C25 both closed), so canStartWork is now true;
  // go/no-go stays false because pilot blockers remain.
  assert.equal(result.canStartWork, true);
  assert.equal(result.blockerCount, result.startBlockerCount + result.pilotBlockerCount + result.scaleBlockerCount);

  // 关掉开工闸门只允许开工，不等于可以试点：2 个试点证据项（C27/C30）仍必须由实施产生。
  // （2026-11-08 由 10 改 7：C03/C16/C17/C22 经主签逐条签字关闭。
  //  2026-11-09 由 7 改 3：C28 关闭（引用 D4-a 端到端 cutover 计时），上面 pilotBlockerCount 同一事实。
  //  2026-11-09 续 由 3 改 2：C26 关闭（§7 M2 播种三个真 seated 提交者 + 窗口重锚到 11-08 的
  //  pilot-metrics.sql 只读重跑，四条 go_gate 全绿；见 C26 evidence 末条与 work-r0a-c26-metrics-collection-2026-11-09.md）。）
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
  assert.equal(afterStart.pilotBlockerCount, 2);
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
