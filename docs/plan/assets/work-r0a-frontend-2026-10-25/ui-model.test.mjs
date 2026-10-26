import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadUiAssets,
  validateMatrix,
  validateCopy,
  actionsFor,
  canAccept,
  canRetry,
  canCancel,
  isArtifactReadOnly,
  taskUiModel,
  canPrepare,
  canSubmit,
  inboxTypeFor,
  routeForTask,
  routeForArtifact,
  itemsRoute,
  legacyRedirect,
  permissionKey,
} from './ui-model.mjs';

const { matrix, routes, copy } = loadUiAssets();

test('state matrix and copy are internally complete', () => {
  assert.deepEqual(validateMatrix(matrix), []);
  assert.deepEqual(validateCopy(matrix, copy), []);
  assert.equal(Object.keys(matrix.states).length, 12);
  assert.equal(routes.routes.admin, '/admin/work');
});

test('task canceled/archived are reserved for R0b: read-only, no management actions', () => {
  const reserved = Object.entries(matrix.states)
    .filter(([, entry]) => entry.reservedFor === 'R0b')
    .map(([state]) => state);
  assert.deepEqual(reserved.sort(), ['archived', 'canceled']);
  const broken = structuredClone(matrix);
  broken.management.delete.states.push('archived');
  broken.states.canceled.actions.push('retry');
  assert.deepEqual(validateMatrix(broken).sort(), [
    'management delete references reserved state archived',
    'reserved state canceled must be read-only',
  ]);
});

test('reconciling blocks retry/accept but allows a request to cancel', () => {
  assert.deepEqual(actionsFor('reconciling'), ['view_timeline', 'cancel']);
  assert.equal(canRetry('reconciling'), false);
  assert.equal(canCancel('reconciling'), true);
  assert.equal(
    canAccept({ display_state: 'reconciling', pending_acceptance: false, blocking_operations: 1 }),
    false,
  );
});

test('awaiting acceptance exposes accept only when quiescent', () => {
  assert.ok(actionsFor('awaiting_acceptance').includes('accept'));
  assert.equal(
    canAccept({ display_state: 'awaiting_acceptance', pending_acceptance: true, blocking_operations: 0 }),
    true,
  );
  assert.equal(
    canAccept({ display_state: 'awaiting_acceptance', pending_acceptance: false, blocking_operations: 0 }),
    false,
  );
  assert.equal(
    canAccept({ display_state: 'awaiting_acceptance', pending_acceptance: true, blocking_operations: 1 }),
    false,
  );
});

test('canceled run keeps read-only artifact and allows retry, not accept', () => {
  assert.deepEqual(actionsFor('run_canceled'), ['view_artifact_readonly', 'retry']);
  assert.equal(canRetry('run_canceled'), true);
  assert.equal(canCancel('run_canceled'), false);
  assert.equal(isArtifactReadOnly('run_canceled'), true);
  assert.equal(
    canAccept({ display_state: 'run_canceled', pending_acceptance: true, blocking_operations: 0 }),
    false,
  );
});

test('failed retries; budget exhaustion cancels but does not retry', () => {
  assert.deepEqual(actionsFor('failed'), ['view_error', 'retry']);
  assert.equal(isArtifactReadOnly('failed'), true);
  assert.equal(canRetry('failed'), true);
  assert.equal(canCancel('failed'), false);
  assert.deepEqual(actionsFor('budget_exhausted'), ['view_budget', 'cancel']);
  assert.equal(canRetry('budget_exhausted'), false);
  assert.equal(canCancel('budget_exhausted'), true);
});

test('completed and terminal tasks do not expose cancel/retry/accept', () => {
  assert.deepEqual(actionsFor('completed'), ['open_artifact', 'export', 'continue']);
  assert.equal(isArtifactReadOnly('completed'), true);
  assert.equal(canRetry('completed'), false);
  assert.equal(canCancel('completed'), false);
  for (const state of ['canceled', 'archived']) {
    assert.equal(canRetry(state), false);
    assert.equal(canCancel(state), false);
    assert.equal(isArtifactReadOnly(state), true);
    assert.deepEqual(actionsFor(state), ['view_artifact_readonly']);
  }
});

test('taskUiModel keeps server display_state as the only state source', () => {
  const model = taskUiModel({
    task_id: 'task-1',
    display_state: 'awaiting_acceptance',
    task_state: 'awaiting_acceptance',
    pending_acceptance: true,
    blocking_operations: 0,
  });
  assert.equal(model.displayState, 'awaiting_acceptance');
  assert.equal(model.labelKey, 'work.r0a.state.awaiting_acceptance');
  assert.equal(model.tone, 'attention');
  assert.equal(model.canAccept, true);
  assert.equal(model.canRetry, false);
  assert.deepEqual(model.actions, ['open_artifact', 'accept', 'export']);
});

test('composer prepare/submit gates respect feature, seat, length, busy and preview', () => {
  const base = { featureEnabled: true, workSeat: true, goal: '写方案', maxGoalChars: 2000, busy: false };
  assert.equal(canPrepare(base), true);
  assert.equal(canPrepare({ ...base, featureEnabled: false }), false);
  assert.equal(canPrepare({ ...base, workSeat: false }), false);
  assert.equal(canPrepare({ ...base, goal: '   ' }), false);
  assert.equal(canPrepare({ ...base, goal: 'x'.repeat(2001) }), false);
  assert.equal(canPrepare({ ...base, busy: true }), false);
  assert.equal(canSubmit({ ...base, hasPreview: true, previewStale: false }), true);
  assert.equal(canSubmit({ ...base, hasPreview: false, previewStale: false }), false);
  assert.equal(canSubmit({ ...base, hasPreview: true, previewStale: true }), false);
});

test('inbox projection maps only acceptance/failed/reconciling', () => {
  assert.equal(inboxTypeFor('awaiting_acceptance'), 'acceptance_required');
  assert.equal(inboxTypeFor('failed'), 'failed');
  assert.equal(inboxTypeFor('reconciling'), 'reconciling');
  for (const state of ['queued', 'running', 'completed', 'run_canceled', 'budget_exhausted']) {
    assert.equal(inboxTypeFor(state), null);
  }
});

test('route helpers and legacy redirects preserve stable deep links', () => {
  assert.equal(routeForTask('t1'), '/work/items/t1');
  assert.equal(routeForArtifact('t1', 'a1'), '/work/items/t1/artifacts/a1');
  assert.equal(itemsRoute('awaiting_acceptance'), '/work/items?view=awaiting_acceptance');
  assert.throws(() => itemsRoute('unknown'), (error) => error.code === 'invalid_view');
  assert.deepEqual(legacyRedirect('?view=new'), { to: '/work/new', noticeKey: null });
  assert.deepEqual(legacyRedirect('?view=history'), { to: '/work/archive', noticeKey: null });
  assert.deepEqual(legacyRedirect('?view=running'), { to: '/work/items?view=running', noticeKey: null });
  assert.deepEqual(legacyRedirect(''), { to: '/work/items', noticeKey: null });
  const legacyTask = legacyRedirect('?task=old-1');
  assert.equal(legacyTask.to, '/work/archive?legacyTask=old-1');
  assert.equal(legacyTask.noticeKey, 'work.r0a.legacy.notice');
});

test('permission copy explicitly avoids fake per-action approvals in R0a', () => {
  const key = permissionKey('ask_each');
  assert.equal(key, 'work.r0a.permission.ask_each');
  assert.match(copy[key], /不会出现逐次审批/);
  assert.doesNotMatch(copy[key], /等待审批/);
  assert.equal(permissionKey('auto_readonly'), 'work.r0a.permission.auto_readonly');
  assert.throws(() => permissionKey('plan_then_run'), (error) => error.code === 'invalid_permission_mode');
});

test('delete is only offered for quiescent tasks and always confirms; rename is desktop-only', async () => {
  const { canDelete, canRename } = await import('./ui-model.mjs');
  const { matrix, copy } = loadUiAssets();
  assert.equal(matrix.actions.delete.requiresConfirm, true);
  assert.equal(matrix.actions.delete.destructive, true);
  for (const state of ['queued', 'running', 'reconciling', 'budget_exhausted', 'canceling']) {
    assert.equal(canDelete({ display_state: state, active_run_id: null, blocking_operations: 0 }), false, state);
  }
  assert.equal(canDelete({ display_state: 'completed', active_run_id: null, blocking_operations: 0 }), true);
  assert.equal(canDelete({ display_state: 'failed', active_run_id: null, blocking_operations: 1 }), false);
  assert.equal(canRename({ display_state: 'running' }), true);
  assert.equal(canRename({ display_state: 'archived' }), false);
  assert.equal(canRename({ display_state: 'completed' }, { mobile: true }), false);
  for (const code of ['title_invalid', 'csrf_invalid', 'task_archived', 'artifact_read_only', 'run_not_quiescent', 'org_execution_unavailable', 'work_seat_required']) {
    assert.ok(copy[`work.r0a.error.${code}`], code);
  }
  assert.ok(!/恢复|撤回/.test(copy['work.r0a.confirm.delete.body']));
});
