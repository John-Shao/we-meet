// 2026-11-13 (batch B3, review finding #4). The review asked for "a state x action matrix asset plus
// a model test". Both already existed and still exist: the asset is
// docs/plan/assets/work-r0a-frontend-2026-10-25/state-matrix.json (version r0a-v1, 12 states x 12
// actions), the model test is ui-model.test.mjs beside it (14 named tests), and the shipped page is
// pinned to the asset by src/frontend/.../r0a/routes/TaskWorkspaceMatrixDrift.test.tsx, which reads
// the JSON file itself rather than a copy typed into the test. So the layer the review found missing
// is not "asset" or "test" - it is matrix <-> server truth. Nothing until this file compared the
// asset's three action constraints and its management sets against the SQL that actually refuses
// work, nor against the shipped error-code contract, nor against which of the 12 x 12 cells any test
// in the repo touches.
//
// What this guard pins: the display states the asset lists are exactly the states the SQL view can
// emit; every state literal in that CASE can actually occur (a guard against silently-dead branches
// after an enum change); cancel/retry/accept eligibility derived from the server functions equals the
// asset's onlyStates; each refusal code the four constrained actions can produce is 409 + not
// retryable in src/work/contracts/error-codes.json and has a SQL RAISE site and a named Go test; and
// every covered cell names a test that still exists on disk.
// What it does NOT pin: the one place the UI and the server do NOT agree - the scope of
// "blocking operations" - which is asserted as a divergence and registered as 卡片 X in
// docs/plan/work-project.md rather than silently unified either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// test/ -> design asset dir -> assets -> plan -> docs -> repo root.
const ASSETS_DIR = join(HERE, '..', '..');
const REPO = join(HERE, '..', '..', '..', '..', '..');
const FRONTEND_DIR = join(ASSETS_DIR, 'work-r0a-frontend-2026-10-25');
const DOC = join(REPO, 'docs', 'plan', 'work-project.md');
const MATRIX_PATH = join(FRONTEND_DIR, 'state-matrix.json');
const UI_MODEL = join(FRONTEND_DIR, 'ui-model.mjs');
const UI_MODEL_TEST = join(FRONTEND_DIR, 'ui-model.test.mjs');
const DRIFT_TEST = join(
  REPO,
  'src/frontend/src/features/work/r0a/routes/TaskWorkspaceMatrixDrift.test.tsx'
);
const BASELINE = join(REPO, 'src/work/migrations/baseline/0002_initial_r0a_schema.sql');
const INCREMENTS_DIR = join(REPO, 'src/work/migrations/increments');
const CATALOGS_DIR = join(REPO, 'src/work/migrations/catalogs');
const CONTRACTS = join(REPO, 'src/work/contracts/error-codes.json');

const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
// Comment lines state intent; only code lines may satisfy a structural assertion. The sibling gates
// in this directory learned that on 2026-11-05, when a Chinese comment about the very thing a check
// looked for satisfied the check after the code stopped doing the work.
const codeOnly = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(--|#(?!if|endif|include)|\/\/)/.test(line))
    .join('\n');
const baseline = codeOnly(readFileSync(BASELINE, 'utf8'));
// The chain, in application order: baseline then increments. Reading the baseline alone reads dead
// code for retry_task, which increment 0005 replaces with CREATE OR REPLACE - measured while
// writing this file, where the first version of functionBody() returned the 0002 body.
const INCREMENT_FILES = readdirSync(INCREMENTS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
assert.ok(INCREMENT_FILES.length >= 20, `read ${INCREMENT_FILES.length} increments - the scan is broken`);
const AUTHORITY = [
  baseline,
  ...INCREMENT_FILES.map((f) => codeOnly(readFileSync(join(INCREMENTS_DIR, f), 'utf8'))),
].join('\n');
const contracts = JSON.parse(readFileSync(CONTRACTS, 'utf8'));

// ---------------------------------------------------------------- SQL structure

const enumFor = (table) => {
  const start = AUTHORITY.indexOf(`CREATE TABLE work.${table} (`);
  assert.notEqual(start, -1, `the chain must define work.${table}`);
  const m = /state text NOT NULL CHECK \(state IN \(([^)]*)\)\)/.exec(AUTHORITY.slice(start));
  assert.ok(m, `work.${table} must declare a state CHECK enum`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};
const TASK_STATES = enumFor('task');
const RUN_STATES = enumFor('run');
const OPERATION_STATES = enumFor('operation');

assert.equal([...AUTHORITY.matchAll(/END AS display_state/g)].length, 1,
  'more than one display_state definition in the chain - re-choose which one this gate reads');
const displayTail = AUTHORITY.indexOf('END AS display_state');
const caseStart = AUTHORITY.lastIndexOf('CASE', displayTail);
assert.notEqual(caseStart, -1, 'display_state must still be a CASE expression');
const CASE_BLOCK = AUTHORITY.slice(caseStart, displayTail);

// A lazy arm scan, because two arms carry a multi-line EXISTS subquery: a line-by-line reader
// silently drops them. Measured while writing this file - a line-based scan derived cancel-eligible
// as {queued, running, quota_exhausted} and lost `reconciling`.
const ARMS = [...CASE_BLOCK.matchAll(/\bWHEN\b([\s\S]*?)\bTHEN\s+'([a-z_]+)'/g)].map(([, cond, out]) => {
  const taskLiterals = [...cond.matchAll(/\bt\.state\s*=\s*'([a-z_]+)'/g),
    ...[...cond.matchAll(/\bt\.state\s+IN\s*\(([^)]*)\)/g)].flatMap(([, list]) =>
      [...list.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    )].map((m) => (typeof m === 'string' ? m : m[1]));
  const runLiterals = [...cond.matchAll(/\br\.state\s*=\s*'([a-z_]+)'/g),
    ...[...cond.matchAll(/\br\.state\s+IN\s*\(([^)]*)\)/g)].flatMap(([, list]) =>
      [...list.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    )].map((m) => (typeof m === 'string' ? m : m[1]));
  const testsWaitReason = /r\.wait_reason\s*=\s*'([a-z_]+)'/.test(cond);
  const testsExists = /\bEXISTS\b/.test(cond);
  const other = cond
    .replace(/\bt\.state\s*=\s*'[a-z_]+'/g, '')
    .replace(/\bt\.state\s+IN\s*\([^)]*\)/g, '')
    .replace(/\br\.state\s*=\s*'[a-z_]+'/g, '')
    .replace(/\br\.state\s+IN\s*\([^)]*\)/g, '')
    .replace(/\br\.wait_reason\s*=\s*'[a-z_]+'/g, '')
    .replace(/\bAND\b/gi, ' ')
    .replace(/\bEXISTS\b[\s\S]*/, '')
    .trim();
  return { cond, out, taskLiterals, runLiterals, testsWaitReason, testsExists, other };
});
const ELSE_STATE = /ELSE\s+'([a-z_]+)'/.exec(CASE_BLOCK)?.[1];

test('the display_state CASE parses into arms this file can actually reason about', () => {
  assert.ok(ARMS.length >= 10, `expected at least 10 CASE arms, read ${ARMS.length}`);
  assert.ok(ELSE_STATE, 'the CASE must keep an ELSE branch');
  for (const arm of ARMS) {
    // Every literal must be one the column can hold: a guard against a branch that stopped being
    // reachable when the CHECK enum changed under it.
    for (const lit of arm.taskLiterals) {
      assert.ok(TASK_STATES.includes(lit), `arm for '${arm.out}' tests task state '${lit}', not in the task enum`);
    }
    for (const lit of arm.runLiterals) {
      assert.ok(RUN_STATES.includes(lit), `arm for '${arm.out}' tests run state '${lit}', not in the run enum`);
    }
    assert.ok(
      arm.taskLiterals.length || arm.runLiterals.length,
      `arm '${arm.out}' tests neither t.state nor r.state - this parser would evaluate it wrongly`
    );
    assert.equal(arm.other, '', `arm '${arm.out}' has a predicate this parser does not model: ${arm.cond}`);
  }
});

// Mirrors the CASE arm order. Inputs are the columns the arms read, so the evaluation is the SQL's,
// not a restatement of the asset.
const evaluate = (taskState, runState, waitReason, existsUnresolved) => {
  for (const arm of ARMS) {
    if (arm.taskLiterals.length && !arm.taskLiterals.includes(taskState)) continue;
    if (arm.runLiterals.length && (!runState || !arm.runLiterals.includes(runState))) continue;
    if (arm.testsWaitReason && waitReason !== 'quota') continue;
    if (arm.testsExists && !existsUnresolved) continue;
    return arm.out;
  }
  return ELSE_STATE;
};

const RUN_STATES_ALL = [...RUN_STATES, null];
const reachAll = (predicate) => {
  const out = new Set();
  for (const t of TASK_STATES) {
    for (const r of RUN_STATES_ALL) {
      for (const w of ['quota', null]) {
        for (const e of [true, false]) {
          if (predicate(t, r, w, e)) out.add(evaluate(t, r, w, e));
        }
      }
    }
  }
  return out;
};

test('the twelve states the asset names are exactly the states the view can emit', () => {
  const emitted = reachAll(() => true);
  assert.ok(emitted.size >= 11, `evaluator produced only ${emitted.size} states - the CASE was rewritten`);
  for (const state of Object.keys(matrix.states)) {
    assert.ok(emitted.has(state), `asset state '${state}' is not reachable from the SQL CASE`);
  }
  for (const state of emitted) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(matrix.states, state),
      `the SQL can emit '${state}' and the asset has no cell for it`
    );
  }
  assert.equal(emitted.size, Object.keys(matrix.states).length);
});

// --------------------------------------------------- server refusal sites -> eligibility

// The call sites in src/work/internal are the only thing that decides which overload actually runs,
// so the arity of the body this gate reads is checked against them rather than assumed.
const goCallArity = (name) => {
  const dir = join(REPO, 'src/work/internal');
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [/\.go$/.test(e.name) && !/_test\.go$/.test(e.name) ? join(d, e.name) : null]
        .filter(Boolean)
    );
  const hits = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(new RegExp(`work\\.${name}\\(([^)]*)\\)`, 'g'))) {
      const arity = [...m[1].matchAll(/\$\d/g)].length;
      // Prose mentions of the function in comments carry no placeholders; only a real call counts.
      if (arity > 0) hits.push([file, arity]);
    }
  }
  return [...new Set(hits.map(([, a]) => a))];
};

const functionBody = (name) => {
  // accept_task exists twice in the baseline: the R0a body is DROPped and replaced by the R0b
  // governance body, and only the last definition is the server. Taking the first would have read
  // a guard that no longer runs, which is the failure mode this whole file exists to catch.
  const defs = [
    ...AUTHORITY.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION work\\.${name}\\(([^)]*)\\)`, 'g')),
  ];
  assert.ok(defs.length >= 1, `the chain must define work.${name}`);
  for (let i = 0; i + 1 < defs.length; i += 1) {
    const aritySame = defs[i][1].split(',').filter((s) => s.trim()).length ===
      defs[i + 1][1].split(',').filter((s) => s.trim()).length;
    if (aritySame) {
      const drop = AUTHORITY.indexOf(`DROP FUNCTION work.${name}`, defs[i].index, defs[i + 1].index);
      const replace = AUTHORITY.indexOf(
        `CREATE OR REPLACE FUNCTION work.${name}`,
        defs[i].index,
        defs[i + 1].index
      );
      assert.notEqual(
        drop === -1 ? replace : drop,
        -1,
        `work.${name} is redefined at ${defs[i + 1].index} with the same signature and no DROP/OR REPLACE`
      );
    }
  }
  const last = defs[defs.length - 1];
  const arity = last[1].split(',').filter((s) => s.trim()).length;
  const call = goCallArity(name);
  if (call.length) {
    assert.deepEqual(
      call,
      [arity],
      `work.${name} is called from Go with ${call.join('/')} args but the last definition takes ${arity}`
    );
  }
  const end = AUTHORITY.indexOf('\n$$;', last.index);
  assert.notEqual(end, -1, `work.${name} body must end with a dollar-quoted block`);
  return AUTHORITY.slice(last.index, end);
};

const refusalSet = (body, column) => {
  const m = new RegExp(`\\b${column}\\.state IN \\(([^)]*)\\)\\s*THEN`, 's').exec(body)
    ?? new RegExp(`\\b${column}\\.state IN \\(([^)]*)\\)`, 's').exec(body);
  assert.ok(m, `expected a '${column}.state IN (...)' refusal guard in the function body`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};

test('cancel eligibility is the run states request_cancel refuses to refuse', () => {
  const body = functionBody('request_cancel');
  const refused = refusalSet(body, 'run_row');
  for (const s of ['succeeded', 'failed', 'canceled', 'cancel_requested']) {
    assert.ok(refused.includes(s), `request_cancel no longer refuses '${s}': ${refused.join(',')}`);
  }
  const eligibleRunStates = RUN_STATES.filter((s) => !refused.includes(s));
  assert.deepEqual(eligibleRunStates.sort(), ['active', 'queued', 'waiting']);

  // The display states an eligible run can be the one standing in for - arms whose run guard only
  // names eligible run states. Precedence does the rest: a terminal task state shadows them.
  const derived = new Set(
    ARMS.filter((a) => a.runLiterals.length && a.runLiterals.every((s) => eligibleRunStates.includes(s)))
      .map((a) => a.out)
  );
  const declared = matrix.constraints.cancel.onlyStates;
  for (const s of derived) {
    assert.ok(declared.includes(s), `the server lets a request cancel '${s}' and the asset forbids it`);
  }
  for (const s of declared) {
    assert.ok(derived.has(s), `the asset offers cancel on '${s}' and request_cancel would refuse it`);
  }
  assert.equal(derived.size, declared.length);
});

test('retry and accept eligibility match retry_task and accept_task guards', () => {
  // The anti-dead-code machinery itself, pinned: both names have two definitions in the chain
  // (retry_task: baseline 0002 then CREATE OR REPLACE in increment 0005; accept_task: the R0a body
  // dropped at 0002:3220 then the governance body), and the arity below is what work-api calls. An
  // empty call list here would silently skip every arity check in this file.
  assert.deepEqual(goCallArity('retry_task'), [7]);
  assert.deepEqual(goCallArity('accept_task'), [8]);
  const retry = functionBody('retry_task');
  const wantTask = /task_row\.state\s*<>\s*'([a-z_]+)'/.exec(retry);
  assert.ok(wantTask, 'retry_task must still require one task state');
  const allowedRuns = /latest_state NOT IN \(([^)]*)\)/.exec(retry);
  assert.ok(allowedRuns, 'retry_task must still name the run states it accepts');
  const runList = [...allowedRuns[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  const derivedRetry = new Set(runList.map((r) => evaluate(wantTask[1], r, null, false)));
  const declaredRetry = matrix.constraints.retry.onlyStates;
  assert.deepEqual([...derivedRetry].sort(), [...declaredRetry].sort());

  const accept = functionBody('accept_task');
  const acceptState = /task_row\.state\s*<>\s*'([a-z_]+)'/.exec(accept);
  assert.ok(acceptState, 'accept_task must still require one task state');
  assert.deepEqual(matrix.constraints.accept.onlyStates, [acceptState[1]]);
  // The asset's two extra accept clauses must both be columns the view really computes.
  assert.match(AUTHORITY, /\(t\.state = 'awaiting_acceptance'\) AS pending_acceptance/);
  assert.match(AUTHORITY, /\) AS blocking_operations/);
  assert.equal(matrix.constraints.accept.requiresPendingAcceptance, true);
});

test('delete is offered only on states the server would accept a delete in', () => {
  // delete_task_core never tests task.state: it refuses on active_run_id and blocking operations.
  // So "server-deletable" is a function of quiescence, and the asset's narrower list is a product
  // restriction. Pinned in the one direction that matters - the asset must never offer a state the
  // server refuses - plus the exact list of states the server allows and the page hides.
  const core = functionBody('delete_task_core');
  assert.doesNotMatch(core, /task_row\.state\s*(?:<>|IN|NOT IN)/,
    'delete_task_core grew a task-state guard; the delete row of the coverage map must be re-read');
  const quiescentReachable = reachAll((t, r) => r === null || ['failed', 'canceled'].includes(r));
  for (const s of matrix.management.delete.states) {
    assert.ok(quiescentReachable.has(s), `asset offers delete on '${s}', which no quiescent task can display`);
  }
  const hidden = [...quiescentReachable].filter((s) => !matrix.management.delete.states.includes(s)).sort();
  assert.deepEqual(hidden, ['archived', 'canceled'],
    `states the server would delete but the page hides are now: ${hidden.join(',')}`);
  for (const s of hidden) {
    assert.equal(
      matrix.states[s].reservedFor,
      'R0b',
      `'${s}' is server-deletable and hidden by design; the asset must keep saying why`
    );
  }
});

test('rename is offered on every state update_task_title accepts, minus what R0b reserves', () => {
  const title = functionBody('update_task_title');
  const refused = /task_row\.state\s*=\s*'([a-z_]+)'/.exec(title);
  assert.ok(refused, 'update_task_title must still refuse one task state by name');
  assert.equal(refused[1], 'archived');
  const derived = reachAll((t) => t !== refused[1]);
  assert.equal(derived.size, Object.keys(matrix.states).length - 1,
    `a task that is not '${refused[1]}' should display ${Object.keys(matrix.states).length - 1} states`);
  for (const s of matrix.management.rename.states) {
    assert.ok(derived.has(s), `asset offers rename on '${s}', which the server would refuse`);
  }
  const hidden = [...derived].filter((s) => !matrix.management.rename.states.includes(s)).sort();
  assert.deepEqual(hidden, ['canceled'],
    `states the server would rename but the page hides are now: ${hidden.join(',')}`);
  assert.equal(matrix.states.canceled.reservedFor, 'R0b',
    "'canceled' is server-renameable and hidden by design; the asset must keep saying why");
});

test('the matrix is internally consistent: cells and constraints say the same thing', () => {
  for (const [state, cell] of Object.entries(matrix.states)) {
    for (const action of ['cancel', 'retry', 'accept']) {
      const inCell = cell.actions.includes(action);
      const inConstraint = matrix.constraints[action].onlyStates.includes(state);
      assert.equal(inCell, inConstraint, `'${state}' lists '${action}' in its cell but not in constraints.${action}`);
    }
    for (const action of cell.actions) {
      assert.ok(Object.prototype.hasOwnProperty.call(matrix.actions, action), `'${state}' offers unknown action '${action}'`);
    }
    for (const action of ['rename', 'delete']) {
      const inManagement = matrix.management[action].states.includes(state);
      const inCell = cell.actions.includes(action);
      assert.ok(inCell === false || inManagement, `'${state}' offers '${action}' outside management.${action}.states`);
    }
  }
  assert.ok(matrix.management.rename.desktopOnly, 'rename stays desktop-only while the mobile page has no rename');
  assert.ok(matrix.management.delete.requiresQuiescent);
});

// ------------------------------------------------------- refusal codes -> shipped contract

const SQL_RAISE = (code) => [...AUTHORITY.matchAll(new RegExp(`RAISE EXCEPTION '${code}'`, 'g'))].length;

test('every refusal the four constrained actions can return is contracted, raised and tested', () => {
  const rows = [
    { action: 'delete', code: 'run_not_quiescent', goTest: 'TestOpsDeleteTaskRefusesActiveRunForeignTaskAndBadTicket' },
    { action: 'accept', code: 'task_not_acceptable', goTest: 'TestAcceptanceRequiresQuiescentTaskAndIsIdempotent' },
    { action: 'retry', code: 'task_not_runnable', goTest: 'TestRetryTaskRefusesWhenTheTaskOrItsLatestRunIsNotRunnable' },
    { action: 'delete', code: 'task_has_active_run', goTest: 'TestOpsDeleteTaskRefusesActiveRunForeignTaskAndBadTicket' },
    { action: 'rename', code: 'task_archived', goTest: 'TestUpdateTaskTitleIdempotencyAndConflicts' },
  ];
  assert.ok(Object.keys(contracts.public).length >= 50, 'the shipped contract map looks truncated');
  for (const row of rows) {
    const entry = contracts.public[row.code];
    assert.ok(entry, `'${row.code}' is not in ${'src/work/contracts/error-codes.json'}`);
    assert.equal(entry.status, 409, `'${row.code}' must be a conflict`);
    assert.equal(entry.retryable, false, `'${row.code}' must not be retryable`);
    assert.ok(SQL_RAISE(row.code) >= 1, `'${row.code}' is contracted but no SQL function raises it`);
    const goFiles = readdirSync(join(REPO, 'src/work/internal/api'));
    const hit = goFiles.filter((f) =>
      f.endsWith('.go') && readFileSync(join(REPO, 'src/work/internal/api', f), 'utf8').includes(`func ${row.goTest}(`)
    );
    assert.ok(hit.length >= 1, `Go test '${row.goTest}' for '${row.code}' is not in internal/api`);
  }
});

// -------------------------------------------------------------- the one live divergence

test('the UI blocking-operations count is scoped to the latest run while the server refusal spans every run', () => {
  // Read on purpose, not asserted away: work.task_summary counts the operations of the run joined on
  // t.latest_run_id, work.task_has_blocking_operation looks at every run of the task, and ui-model.mjs
  // gates accept and delete on the former while the SQL raises run_not_quiescent on the latter. The
  // same view scopes the same join both ways - the quota columns use the all-runs form. Reachability
  // of a disagreement was checked and not found (see 卡片 X for the write paths that re-check the
  // broad predicate), so this pins the asymmetry as a latent trap rather than claiming a live 409:
  // if either scope is edited alone, or a run is ever created without the broad check, the badge and
  // the refusal split with no test noticing until a user hits it.
  // Scoped slices, not whole-file substrings: `o.run_id = r.id` also appears in the CASE's EXISTS
  // arm, so an unanchored check would stay green after the view count quietly changed scope.
  const viewMark = AUTHORITY.indexOf(') AS blocking_operations');
  assert.notEqual(viewMark, -1, 'the view lost its blocking_operations count - re-read this test');
  const viewScope = AUTHORITY.slice(viewMark - 700, viewMark);
  const view = /o\.state IN \(([^)]*)\)[\s\S]{0,10}$/.exec(viewScope);
  assert.ok(view, 'the blocking_operations count no longer ends where this test reads it');
  assert.match(viewScope, /WHERE o\.run_id = r\.id/, 'the view count is no longer latest-run scoped');
  assert.doesNotMatch(viewScope, /r\.task_id = p_task_id/,
    'the view count now spans the task, so the divergence below no longer exists - re-read this test');

  const fnScope = functionBody('task_has_blocking_operation');
  const fn = /o\.state IN \(\s*([^)]*)\)\s*\)/.exec(fnScope);
  assert.ok(fn, 'task_has_blocking_operation lost its state set - re-read this test');
  assert.match(fnScope, /WHERE r\.task_id = p_task_id/, 'the server refusal is no longer task-wide scoped');
  assert.doesNotMatch(fnScope, /o\.run_id = r\.id/,
    'the server refusal is now latest-run scoped, so the divergence below no longer exists');

  const norm = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort().join(',');
  assert.equal(norm(view[1]), norm(fn[1]), 'the two copies of "blocking operation" no longer name the same states');
  const BLOCKING_OPS = ['authorized', 'dispatching', 'prepared', 'unknown', 'unresolved', 'waiting_approval'];
  assert.equal(norm(fn[1]), BLOCKING_OPS.join(','), 'the blocking set is no longer the six non-terminal op states');

  // The internal half of the same finding: one view, two scopes over one join. If a future edit
  // unifies them, this assertion is where the decision has to be recorded.
  assert.equal([...AUTHORITY.matchAll(/SELECT rr\.id FROM work\.run rr WHERE rr\.task_id = t\.id/g)].length, 2,
    'the quota columns changed their run scope; re-read which scope this view promises');

  // What makes the split latent rather than live: no operation can leave a terminal state, so once a
  // write path has seen the broad predicate false it cannot see it true again. Scanned across the
  // baseline and every increment, because an increment is exactly how such an edge would arrive.
  const operationEdges = [...AUTHORITY.matchAll(/\(\s*'operation',\s*'([a-z_]+)',\s*'([a-z_]+)'\s*\)/g)]
    .map(([, from, to]) => [from, to]);
  assert.ok(operationEdges.length >= 12, `read only ${operationEdges.length} operation edges - the machine moved`);
  const terminalOps = ['canceled', 'failed', 'reconciled', 'succeeded'];
  for (const [from, to] of operationEdges) {
    assert.ok(!terminalOps.includes(from),
      `edge '${from}' -> '${to}' lets an operation re-enter a blocking state: the scope split above is now reachable`);
    assert.ok(OPERATION_STATES.includes(to), `edge targets '${to}', outside the operation enum`);
  }
  const model = codeOnly(readFileSync(UI_MODEL, 'utf8'));
  assert.match(model, /task\.blocking_operations === 0/);
  assert.match(model, /\(task\.blocking_operations \?\? 0\) === 0/);
  // Anchored and specific: the doc contains the literal string 「卡片 X｜」 inside the card-counting
  // method sentence, so an unanchored match would pass with no card at all.
  const doc = readFileSync(DOC, 'utf8');
  assert.match(doc, /^\*\*卡片 X｜#119/m);
  assert.match(doc, /卡片 X｜#119[\s\S]{0,2200}run_not_quiescent/);
  assert.match(doc, /卡片 X｜#119[\s\S]{0,4000}blocking_operations/);
});

// --------------------------------------------------------------- coverage map per cell

const API_DIR = join(REPO, 'src/work/internal/api');
const goTestExists = (name) =>
  readdirSync(API_DIR)
    .filter((f) => f.endsWith('.go'))
    .some((f) => readFileSync(join(API_DIR, f), 'utf8').includes(`func ${name}(`));

// Per constrained action: which named test in which layer looks at it. This is the deliverable the
// review's "covered by model tests" half actually needs - not more tests, but a map that says who
// watches each cell, so an unwatched cell is visible instead of inferred.
const COVERAGE = {
  cancel: {
    server: ['TestCancelRunRequiresCSRFAndIsIdempotent', 'TestOpsCancelRunLeavesATerminalRunAlone',
      'TestCancelRunRejectsViewer', 'TestCancelRunRejectsClientRequestID',
      'TestOpsCancelRunFollowsTheSameHandOff'],
    model: ['reconciling blocks retry/accept but allows a request to cancel',
      'failed retries; quota exhaustion cancels but does not retry',
      'completed and terminal tasks do not expose cancel/retry/accept'],
    page: 'task.cancelRun',
    truth: 'constraints.cancel.onlyStates',
  },
  retry: {
    server: ['TestRetryTaskRefusesWhenTheTaskOrItsLatestRunIsNotRunnable'],
    model: ['failed retries; quota exhaustion cancels but does not retry',
      'canceled run keeps read-only artifact and allows retry, not accept'],
    page: 'task.retryTitle',
    truth: 'constraints.retry.onlyStates',
  },
  accept: {
    server: ['TestAcceptanceRequiresQuiescentTaskAndIsIdempotent',
      'TestAcceptancePinsTheSelectedArtifactVersion'],
    model: ['awaiting acceptance exposes accept only when quiescent',
      'completed and terminal tasks do not expose cancel/retry/accept'],
    page: 'task.acceptTitle',
    truth: 'constraints.accept.onlyStates',
  },
  delete: {
    server: ['TestOpsDeleteTaskRefusesActiveRunForeignTaskAndBadTicket', 'TestDeleteTaskContract'],
    model: ['delete is only offered for quiescent tasks and always confirms; rename is desktop-only',
      'task canceled/archived are reserved for R0b: read-only, no management actions'],
    page: 'task.deleteTitle',
    truth: 'management.delete.states',
  },
  rename: {
    server: ['TestUpdateTaskTitleIdempotencyAndConflicts'],
    model: ['delete is only offered for quiescent tasks and always confirms; rename is desktop-only'],
    page: null,
    truth: 'management.rename.states',
  },
};

test('each constrained action names tests that still exist in the layer that claims them', () => {
  const modelText = readFileSync(UI_MODEL_TEST, 'utf8');
  const drift = readFileSync(DRIFT_TEST, 'utf8');
  assert.ok(Object.keys(COVERAGE).length >= 5, 'the coverage map lost a row');
  for (const [action, row] of Object.entries(COVERAGE)) {
    assert.ok(row.server.length >= 1 && row.model.length >= 1, `'${action}' has no named test in some layer`);
    for (const name of row.server) {
      assert.ok(goTestExists(name), `'${action}' cites Go test '${name}', which is not in internal/api`);
    }
    for (const name of row.model) {
      assert.ok(modelText.includes(name), `'${action}' cites node test '${name}', not in ui-model.test.mjs`);
    }
    if (row.page) {
      assert.ok(drift.includes(row.page), `'${action}' cites the page affordance '${row.page}', not in the drift test`);
    }
    // The asset path the row cites must still exist: a map that points at a renamed constraint is
    // how a coverage claim quietly stops meaning anything.
    const dug = row.truth.split('.').reduce((acc, key) => acc?.[key], matrix);
    assert.ok(Array.isArray(dug) && dug.length >= 1, `'${action}' cites '${row.truth}', which is not a state list`);
  }
  // The drift test walks all twelve cells for four affordances and asserts both directions.
  for (const key of ['constraints.cancel.onlyStates', 'constraints.retry.onlyStates',
    'constraints.accept.onlyStates', 'management.delete.states']) {
    assert.ok(drift.includes(key), `the drift test stopped reading '${key}'`);
  }
  const constrainedCells = new Set([
    ...matrix.constraints.cancel.onlyStates,
    ...matrix.constraints.retry.onlyStates,
    ...matrix.constraints.accept.onlyStates,
    ...matrix.management.delete.states,
  ]);
  assert.equal(constrainedCells.size, 9, 'the four constrained sets no longer overlap into 9 distinct states');
  assert.ok(constrainedCells.size >= Object.keys(matrix.states).length - 4);
  // Every state the constraints name must be reachable in the map, or the map has a blind row.
  for (const action of ['cancel', 'retry', 'accept', 'delete']) {
    const states = action === 'delete' ? matrix.management.delete.states : matrix.constraints[action].onlyStates;
    assert.ok(states.length >= 1, `'${action}' constrains nothing but is still in the map`);
  }
});

// Registered gaps, not accidents: the review asked for a matrix "covered by tests", and the honest
// answer is a per-cell map naming what covers each cell and what nothing covers. Each entry here
// must say how it would be noticed, so the gap cannot quietly become a claim.
const untested = [
  {
    cells: 'open_artifact / view_artifact_readonly / export / continue / view_error / view_timeline / view_quota in every state',
    gap: 'seven of the twelve actions carry no constraint in the asset, so no server truth pins them and no test asserts their per-state presence',
    reopen: 'a rule with onlyStates for any of them, or a second consumer of state-matrix.json, requires this row to move into COVERAGE',
  },
  {
    cells: 'rename in all ten states management.rename lists',
    gap: 'ui-model.test.mjs asserts rename is desktop-only and one Go test covers the server guard, but the frontend page has no rename affordance assertion',
    reopen: 'adding a rename affordance to TaskWorkspaceMatrixDrift.test.tsx, or a mobile rename, fills COVERAGE.rename.page',
  },
  {
    cells: 'cancel on reconciling and quota_exhausted against a live run',
    gap: 'Go tests prove request_cancel refuses terminal runs; the reconciling display needs an operation in unknown/unresolved, which no Go test plants',
    reopen: 'a WORK_TEST_PG_URL test that walks request_cancel from a reconciling task, or a ruling that the display layer alone is the contract',
  },
];

test('the registered gaps stay registered and each carries a reopen condition', () => {
  assert.ok(untested.length >= 3);
  for (const row of untested) {
    assert.ok(row.cells.length > 10);
    assert.ok(row.gap.length > 30, `gap for '${row.cells}' must say what is missing`);
    assert.ok(row.reopen.length > 30, `gap for '${row.cells}' must say what would close it`);
  }
  // The asset declares twelve actions: four are constrained, one is management-only with a page gap,
  // and the remaining seven must each appear by name in the registry above. Nothing may drop out of
  // both maps silently, which is what the disjunct in an earlier draft of this loop did.
  const registry = untested.map((r) => r.cells).join(' ');
  const unconstrained = Object.keys(matrix.actions).filter((a) => !COVERAGE[a]);
  assert.equal(unconstrained.length, 7, `expected 7 unconstrained actions, read ${unconstrained.length}`);
  for (const action of unconstrained) {
    assert.ok(registry.includes(action), `action '${action}' is in neither COVERAGE nor the gap registry`);
  }
  assert.equal(Object.keys(COVERAGE).sort().join(','), 'accept,cancel,delete,rename,retry');
});
