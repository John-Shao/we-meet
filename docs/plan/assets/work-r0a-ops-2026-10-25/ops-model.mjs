/**
 * R0a security/SLO/pilot checklist model.
 *
 * Validates that controls have owners and close conditions, SLOs do not claim
 * unmeasured results, and the pilot go/no-go is blocked until every blocking
 * checklist item has evidence or a signed waiver.
 *
 * Blocking items carry a `gate`: `start` must close before code starts (DR4),
 * `pilot` only before the pilot go/no-go, `scale` before growth. Without the
 * split one flat number mixes "cannot start work" with "cannot pilot".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readJson(name) {
  return JSON.parse(readFileSync(join(here, name), 'utf8'));
}

export function loadOpsAssets() {
  return {
    controls: readJson('security-controls.json'),
    slo: readJson('slo-pilot.json'),
    checklist: readJson('pilot-checklist.json'),
  };
}

export function validateControls(controls) {
  const issues = [];
  const allowed = new Set(['closed', 'partial', 'open', 'out_of_scope']);
  const ids = new Set();
  for (const item of controls.controls) {
    if (ids.has(item.id)) issues.push(`duplicate control id: ${item.id}`);
    ids.add(item.id);
    if (!allowed.has(item.status)) issues.push(`control ${item.id} has invalid status`);
    if (!item.owner) issues.push(`control ${item.id} has no owner`);
    if (!item.closeCondition) issues.push(`control ${item.id} has no close condition`);
    if (!Array.isArray(item.evidence)) issues.push(`control ${item.id} evidence must be an array`);
    if (item.status === 'closed' && item.evidence.length === 0) {
      issues.push(`control ${item.id} is closed without evidence`);
    }
  }
  return issues;
}

export function validateSlo(slo) {
  const issues = [];
  const required = new Set([
    'control_api_availability',
    'submit_accept_p95_ms',
    'status_visible_p95_ms',
    'first_screen_p95_ms',
    'outbox_lag_p95_s',
    'unknown_age_p95_min',
    'budget_reconciliation_diff_cents',
    'technical_success_rate',
  ]);
  const allowed = new Set(['not_measured', 'met', 'missed', 'waived']);
  const ids = new Set();
  for (const metric of slo.metrics) {
    ids.add(metric.id);
    if (!allowed.has(metric.status)) issues.push(`metric ${metric.id} has invalid status`);
    if (!metric.unit || !metric.window || !metric.source) {
      issues.push(`metric ${metric.id} lacks unit/window/source`);
    }
    if (metric.target === undefined) issues.push(`metric ${metric.id} lacks target/null`);
    if (['met', 'missed'].includes(metric.status) && (!metric.evidence || metric.evidence.length === 0)) {
      issues.push(`metric ${metric.id} claims ${metric.status} without evidence`);
    }
    if (metric.status === 'waived' && !metric.note) {
      issues.push(`metric ${metric.id} is waived without a note`);
    }
  }
  for (const id of required) {
    if (!ids.has(id)) issues.push(`missing required SLO metric: ${id}`);
  }
  return issues;
}

export function validateChecklist(checklist) {
  const issues = [];
  const categories = new Set(checklist.categories);
  const allowed = new Set(['todo', 'partial', 'done', 'waived']);
  const gates = new Set(['start', 'pilot', 'scale']);
  const ids = new Set();
  let blocking = 0;
  for (const item of checklist.items) {
    if (ids.has(item.id)) issues.push(`duplicate checklist id: ${item.id}`);
    ids.add(item.id);
    if (!categories.has(item.category)) issues.push(`checklist ${item.id} has invalid category`);
    if (!allowed.has(item.status)) issues.push(`checklist ${item.id} has invalid status`);
    if (!item.owner) issues.push(`checklist ${item.id} has no owner`);
    if (typeof item.blocking !== 'boolean') issues.push(`checklist ${item.id} blocking must be boolean`);
    if (!gates.has(item.gate)) issues.push(`checklist ${item.id} has invalid gate`);
    if (item.blocking) blocking += 1;
    if (item.status === 'done' && (!item.evidence || item.evidence.length === 0)) {
      issues.push(`checklist ${item.id} is done without evidence`);
    }
    if (item.status === 'waived' && !item.note) {
      issues.push(`checklist ${item.id} is waived without a note`);
    }
  }
  if (blocking === 0) issues.push('checklist has no blocking items');
  return issues;
}

export function goNoGo(checklist) {
  const open = (gate) => checklist.items
    .filter((item) => item.blocking && item.gate === gate && !['done', 'waived'].includes(item.status))
    .map((item) => ({ id: item.id, title: item.title, status: item.status, owner: item.owner, gate }));
  const startBlockers = open('start');
  const pilotBlockers = open('pilot');
  const scaleBlockers = open('scale');
  const blockers = [...startBlockers, ...pilotBlockers, ...scaleBlockers];
  return {
    go: blockers.length === 0,
    // canStartWork is the DR4 question; go is the pilot question. A pilot can
    // only start when the implementation evidence behind pilotBlockers exists.
    canStartWork: startBlockers.length === 0,
    startBlockerCount: startBlockers.length,
    pilotBlockerCount: pilotBlockers.length,
    scaleBlockerCount: scaleBlockers.length,
    blockerCount: blockers.length,
    blockers,
    startBlockers,
    pilotBlockers,
    scaleBlockers,
  };
}
