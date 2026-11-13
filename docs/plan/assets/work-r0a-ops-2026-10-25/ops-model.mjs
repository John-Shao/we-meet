/**
 * R0a security/SLO/pilot checklist model.
 *
 * Validates that controls have owners and close conditions, SLOs do not claim
 * unmeasured results, and the pilot go/no-go is blocked until every blocking
 * checklist item has evidence or a signed waiver. Closed checklist items must
 * also state their residual (what is still not true) and its reopen trigger, so
 * that go=true cannot be read as "nothing is outstanding". Since 2026-11-13 (review
 * batch C) the reverse also holds: an item that declares `requiresMeasuredSlo` cannot
 * keep the pilot gate green on validated rules alone while slo-pilot.json says nothing
 * has been measured, so goNoGo() takes both assets and counts that hole as a blocker.
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
    'quota_reconciliation_diff_tokens',
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

// A `done` observability item used to be enough for the pilot gate to print green, even though
// slo-pilot.json said no metric had ever been measured. Declaring the dependency on the item lets
// goNoGo() derive the hole from the SLO asset instead of trusting the colour of one row.
const MEASURED_SLO = new Set(['met', 'missed']);

export function sloMeasurement(slo) {
  const metrics = slo.metrics;
  return {
    metricCount: metrics.length,
    measuredCount: metrics.filter((metric) => MEASURED_SLO.has(metric.status)).length,
    notMeasuredCount: metrics.filter((metric) => metric.status === 'not_measured').length,
    waivedCount: metrics.filter((metric) => metric.status === 'waived').length,
    measuredIds: metrics.filter((metric) => MEASURED_SLO.has(metric.status)).map((metric) => metric.id),
    notMeasuredIds: metrics.filter((metric) => metric.status === 'not_measured').map((metric) => metric.id),
  };
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
    if (item.requiresMeasuredSlo !== undefined && typeof item.requiresMeasuredSlo !== 'boolean') {
      issues.push(`checklist ${item.id} requiresMeasuredSlo must be boolean`);
    }
    if (item.requiresMeasuredSlo === true && !item.blocking) {
      issues.push(`checklist ${item.id} claims to need measured SLO but is not blocking - the flag would decide nothing`);
    }
    if (!gates.has(item.gate)) issues.push(`checklist ${item.id} has invalid gate`);
    if (item.blocking) blocking += 1;
    if (item.status === 'done' && (!item.evidence || item.evidence.length === 0)) {
      issues.push(`checklist ${item.id} is done without evidence`);
    }
    if (item.status === 'waived' && !item.note) {
      issues.push(`checklist ${item.id} is waived without a note`);
    }
    // A closed item is not the same as an item with nothing outstanding, and until 2026-11-13 the
    // difference existed only in prose. Same shape as validateControls' closeCondition rule: the
    // field must be present, non-empty, and - for anything that is not literally "none" - carry a
    // reopen trigger plus a verbatim quote of the item's own text (test/checklist-residuals.test.mjs
    // checks the quote; here we only check the field is not left blank).
    if (['done', 'waived'].includes(item.status)) {
      if (typeof item.residual !== 'string' || item.residual.trim() === '') {
        issues.push(`checklist ${item.id} is ${item.status} without a residual statement`);
      } else if (item.residual !== 'none') {
        if (typeof item.reopenCondition !== 'string' || item.reopenCondition.trim() === '') {
          issues.push(`checklist ${item.id} has a residual with no reopen condition`);
        }
        if (typeof item.residualSource !== 'string' || item.residualSource.trim() === '') {
          issues.push(`checklist ${item.id} has a residual with no source quote`);
        }
      }
    }
  }
  if (blocking === 0) issues.push('checklist has no blocking items');
  return issues;
}

// "closed with nothing left" is the one value the residual vocabulary reserves for a literal none.
const NO_RESIDUAL = 'none';

// A residual whose own text never says what would reopen it: this count is the honest measure of
// "we recorded the hole but not the trigger", so it stays separate from residualCount instead of
// being smoothed into it.
const UNSTATED_REOPEN = "not stated in the item's own text.";

export function residuals(checklist) {
  const closed = checklist.items.filter((item) => ['done', 'waived'].includes(item.status));
  const open = closed.filter((item) => item.residual && item.residual !== NO_RESIDUAL);
  return {
    closedCount: closed.length,
    residualCount: open.length,
    cleanCount: closed.filter((item) => item.residual === NO_RESIDUAL).length,
    unstatedReopenCount: open.filter((item) => (item.reopenCondition ?? '').startsWith(UNSTATED_REOPEN)).length,
    missingResidual: closed.filter((item) => !item.residual).map((item) => item.id),
    byId: Object.fromEntries(open.map((item) => [item.id, item.residual])),
    items: open.map((item) => ({
      id: item.id,
      gate: item.gate,
      status: item.status,
      residual: item.residual,
      reopenCondition: item.reopenCondition,
    })),
  };
}

export function goNoGo(checklist, slo) {
  if (!slo || !Array.isArray(slo.metrics)) {
    throw new Error('goNoGo needs the SLO asset next to the checklist - a gate that never reads what was measured cannot call that surface green');
  }
  const open = (gate) => checklist.items
    .filter((item) => item.blocking && item.gate === gate && !['done', 'waived'].includes(item.status))
    .map((item) => ({ id: item.id, title: item.title, status: item.status, owner: item.owner, gate }));
  const startBlockers = open('start');
  const pilotBlockers = open('pilot');
  const scaleBlockers = open('scale');
  const measurement = sloMeasurement(slo);
  // Nothing measured *and* something still declared unmeasured. An all-`waived` SLO set is a signed
  // decision not to measure, so it does not trip this - the hole being guarded is silence, not a no.
  const measurementBlockers = measurement.measuredCount === 0 && measurement.notMeasuredCount > 0
    ? checklist.items
      .filter((item) => item.blocking && item.requiresMeasuredSlo === true && ['done', 'waived'].includes(item.status))
      .map((item) => ({
        id: item.id, title: item.title, status: item.status, owner: item.owner,
        gate: item.gate, reason: 'slo_not_measured',
      }))
    : [];
  const blockers = [...startBlockers, ...pilotBlockers, ...scaleBlockers, ...measurementBlockers];
  const residual = residuals(checklist);
  return {
    go: blockers.length === 0,
    // canStartWork is the DR4 question; go is the pilot question. A pilot can
    // only start when the implementation evidence behind pilotBlockers exists.
    canStartWork: startBlockers.length === 0,
    startBlockerCount: startBlockers.length,
    pilotBlockerCount: pilotBlockers.length,
    scaleBlockerCount: scaleBlockers.length,
    measurementBlockerCount: measurementBlockers.length,
    blockerCount: blockers.length,
    blockers,
    startBlockers,
    pilotBlockers,
    scaleBlockers,
    measurementBlockers,
    // Printed with the verdict so a green gate states its own measurement surface, and a red one
    // states which half opened up. Both counts come from slo-pilot.json, never from prose.
    sloMetricCount: measurement.metricCount,
    sloMeasuredCount: measurement.measuredCount,
    sloNotMeasuredCount: measurement.notMeasuredCount,
    sloWaivedCount: measurement.waivedCount,
    // go=true answers "is any blocking item unclosed", not "is nothing outstanding". Without these
    // two numbers a reader collapses them, which is the failure this field pair exists to stop.
    residualCount: residual.residualCount,
    unstatedReopenCount: residual.unstatedReopenCount,
    residuals: residual.items,
  };
}
