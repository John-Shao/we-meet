/**
 * R0a UI-state/model checks.
 *
 * Design-time module: it keeps the state matrix, action gating, legacy route
 * mapping and copy keys consistent. It is not a React runtime.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readJson(name) {
  return JSON.parse(readFileSync(join(here, name), 'utf8'));
}

export function loadUiAssets() {
  return {
    matrix: readJson('state-matrix.json'),
    routes: readJson('routes.json'),
    copy: readJson('copy.zh-CN.json'),
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function validateMatrix(matrix) {
  const errors = [];
  for (const [state, entry] of Object.entries(matrix.states)) {
    for (const action of entry.actions) {
      if (!matrix.actions[action]) errors.push(`state ${state} references unknown action ${action}`);
    }
    if (entry.primaryAction && !entry.actions.includes(entry.primaryAction)) {
      errors.push(`state ${state} primary action is not in its action list`);
    }
  }
  for (const [action, entry] of Object.entries(matrix.actions)) {
    if (!entry.labelKey) errors.push(`action ${action} has no label key`);
  }
  for (const [action, rule] of Object.entries(matrix.management ?? {})) {
    if (!matrix.actions[action]) errors.push(`management action ${action} has no action entry`);
    for (const state of rule.states) {
      if (!matrix.states[state]) errors.push(`management ${action} references unknown state ${state}`);
    }
  }
  return errors;
}

export function validateCopy(matrix, copy) {
  const missing = [];
  for (const [state, entry] of Object.entries(matrix.states)) {
    if (!copy[entry.labelKey]) missing.push(entry.labelKey);
    if (entry.bannerKey && !copy[entry.bannerKey]) missing.push(entry.bannerKey);
  }
  for (const [action, entry] of Object.entries(matrix.actions)) {
    if (!copy[entry.labelKey]) missing.push(entry.labelKey);
  }
  return [...new Set(missing)];
}

export function actionsFor(displayState) {
  const entry = loadUiAssets().matrix.states[displayState];
  if (!entry) fail('unknown_display_state', `unknown display state: ${displayState}`);
  return [...entry.actions];
}

export function canAccept(task) {
  const { matrix } = loadUiAssets();
  const rule = matrix.constraints.accept;
  return (
    rule.onlyStates.includes(task.display_state) &&
    (!rule.requiresPendingAcceptance || task.pending_acceptance === true) &&
    (!rule.requiresNoBlockingOperations || task.blocking_operations === 0)
  );
}

export function canRetry(displayState) {
  return loadUiAssets().matrix.constraints.retry.onlyStates.includes(displayState);
}

export function canCancel(displayState) {
  return loadUiAssets().matrix.constraints.cancel.onlyStates.includes(displayState);
}

export function isArtifactReadOnly(displayState) {
  return ['run_canceled', 'canceled', 'archived'].includes(displayState);
}

export function taskUiModel(task) {
  const { matrix } = loadUiAssets();
  const entry = matrix.states[task.display_state];
  if (!entry) fail('unknown_display_state', `unknown display state: ${task.display_state}`);
  return {
    displayState: task.display_state,
    labelKey: entry.labelKey,
    tone: entry.tone,
    actions: [...entry.actions],
    primaryAction: entry.primaryAction,
    bannerKey: entry.bannerKey,
    canAccept: canAccept(task),
    canRetry: canRetry(task.display_state),
    canCancel: canCancel(task.display_state),
    artifactReadOnly: isArtifactReadOnly(task.display_state),
  };
}

export function canPrepare({ featureEnabled, workSeat, goal, maxGoalChars, busy }) {
  return (
    featureEnabled === true &&
    workSeat === true &&
    typeof goal === 'string' &&
    goal.trim().length > 0 &&
    goal.length <= maxGoalChars &&
    busy !== true
  );
}

export function canSubmit({ hasPreview, previewStale, ...gate }) {
  return canPrepare(gate) && hasPreview === true && previewStale !== true;
}

export function inboxTypeFor(displayState) {
  if (displayState === 'awaiting_acceptance') return 'acceptance_required';
  if (displayState === 'failed') return 'failed';
  if (displayState === 'reconciling') return 'reconciling';
  return null;
}

export function routeForTask(taskId) {
  return `/work/items/${encodeURIComponent(taskId)}`;
}

export function routeForArtifact(taskId, artifactId) {
  return `/work/items/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function itemsRoute(view = 'all') {
  const { routes } = loadUiAssets();
  if (!routes.views.includes(view)) fail('invalid_view', `invalid task view: ${view}`);
  return `${routes.routes.items}?view=${encodeURIComponent(view)}`;
}

/**
 * Old Work links used /work?view=...&task=... . R0a does not migrate old task
 * data, so a legacy task link goes to the read-only archive notice.
 */
export function legacyRedirect(search) {
  const { routes } = loadUiAssets();
  const params = new URLSearchParams(search);
  const taskId = params.get('task');
  if (taskId) {
    return {
      to: `${routes.routes.archive}?legacyTask=${encodeURIComponent(taskId)}`,
      noticeKey: routes.legacy.noticeKey,
    };
  }
  const view = params.get('view');
  if (view === 'new') return { to: routes.routes.composer, noticeKey: null };
  if (view === 'history') return { to: routes.routes.archive, noticeKey: null };
  if (view && routes.views.includes(view)) {
    return { to: itemsRoute(view), noticeKey: null };
  }
  return { to: routes.routes.items, noticeKey: null };
}

export function permissionKey(mode) {
  if (mode !== 'ask_each' && mode !== 'auto_readonly') {
    fail('invalid_permission_mode', `unsupported R0a permission mode: ${mode}`);
  }
  return `work.r0a.permission.${mode}`;
}

export function canDelete(task) {
  const { matrix } = loadUiAssets();
  const entry = matrix.states[task.display_state];
  return Boolean(
    entry &&
      matrix.management.delete.states.includes(task.display_state) &&
      task.active_run_id == null &&
      (task.blocking_operations ?? 0) === 0,
  );
}

export function canRename(task, { mobile = false } = {}) {
  const { matrix } = loadUiAssets();
  const rule = matrix.management.rename;
  return !(mobile && rule.desktopOnly) && rule.states.includes(task.display_state);
}
