import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTelemetry,
  renderRules,
  validateTelemetry,
} from './telemetry-model.mjs';

const { contract, slos, rulesYaml } = loadTelemetry();

function validate(overrides = {}) {
  return validateTelemetry({
    contract: overrides.contract ?? contract,
    slos: overrides.slos ?? slos,
    rulesYaml: overrides.rulesYaml ?? rulesYaml,
  });
}

test('telemetry contract covers every SLO and keeps targets aligned', () => {
  const result = validate();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary, {
    slos: 12,
    trackOnly: 3,
    records: 21,
    alerts: 19,
    metrics: 19,
  });
  const ids = new Set(contract.slos.map((entry) => entry.id));
  assert.equal(ids.size, slos.metrics.length);
  assert.ok(slos.metrics.every((metric) => ids.has(metric.id)));
});

test('track-only SLOs never page as SLO alerts but can keep operational alerts', () => {
  const trackOnly = contract.slos.filter((entry) => entry.track_only);
  assert.equal(trackOnly.length, 3);
  for (const entry of trackOnly) {
    assert.equal(entry.target, null);
    assert.ok(entry.alerts.every((alert) => alert.slo_alert === false));
  }
  const provider = contract.slos.find((entry) => entry.id === 'provider_error_rate');
  assert.ok(provider.alerts.some((alert) => alert.name === 'WorkProviderAuthFailures'));
});

test('every non-track-only SLO has an SLO alert with a runbook', () => {
  for (const entry of contract.slos.filter((item) => !item.track_only)) {
    const sloAlerts = entry.alerts.filter((alert) => alert.slo_alert === true);
    assert.ok(sloAlerts.length >= 1, entry.id);
    for (const alert of sloAlerts) {
      assert.ok(['page', 'ticket'].includes(alert.severity));
      assert.match(alert.for, /^\d+[smhd]$/);
      assert.ok(alert.runbook.includes('#'));
    }
  }
});

test('generated rules are drift-checked against the contract', () => {
  assert.equal(renderRules(contract), rulesYaml);
  assert.ok(rulesYaml.includes('name: work-r0a-slo-recording'));
  assert.ok(rulesYaml.includes('name: work-r0a-alerts'));
  assert.ok(!rulesYaml.includes('prompt='));
});

test('missing telemetry coverage is rejected', () => {
  const mutated = structuredClone(contract);
  mutated.slos = mutated.slos.filter((entry) => entry.id !== 'ttft_p95_ms');
  const result = validate({ contract: mutated, rulesYaml: renderRules(mutated) });
  assert.ok(result.errors.some((error) => error.includes('missing telemetry for ttft_p95_ms')));
});

test('target drift from slo-pilot is rejected', () => {
  const mutated = structuredClone(contract);
  mutated.slos[0].target = 99.5;
  const result = validate({ contract: mutated, rulesYaml: renderRules(mutated) });
  assert.ok(result.errors.some((error) => error.includes('target 99.5')));
});

test('fabricating an SLO alert for a track-only metric is rejected', () => {
  const mutated = structuredClone(contract);
  const acceptance = mutated.slos.find((entry) => entry.id === 'acceptance_rate');
  acceptance.alerts.push({
    name: 'WorkAcceptanceRateLow',
    expr: 'work:track_task_acceptance:ratio_1d < 0.5',
    for: '1h',
    severity: 'ticket',
    slo_alert: true,
    summary: 'made up',
    runbook: 'work-operations-runbook-2026-10-25.md#4-slo-测量方案',
  });
  const result = validate({ contract: mutated, rulesYaml: renderRules(mutated) });
  assert.ok(result.errors.some((error) => error.includes('track-only SLO must not emit an SLO alert')));
});

test('content-bearing labels and undeclared metrics are rejected', () => {
  const mutated = structuredClone(contract);
  mutated.metrics.work_api_requests_total.labels.push('goal');
  mutated.slos[0].recording[0].expr =
    'sum(rate(work_private_prompt_total[5m]))';
  const result = validate({ contract: mutated, rulesYaml: renderRules(mutated) });
  assert.ok(result.errors.some((error) => error.includes('forbidden label goal')));
  assert.ok(result.errors.some((error) => error.includes('undeclared metric work_private_prompt_total')));
});

test('missing runbook anchors are rejected', () => {
  const mutated = structuredClone(contract);
  mutated.slos[0].alerts[0].runbook =
    'work-operations-runbook-2026-10-25.md#not-a-real-anchor';
  const result = validate({ contract: mutated, rulesYaml: renderRules(mutated) });
  assert.ok(result.errors.some((error) => error.includes('runbook anchor missing')));
});

test('all declared metrics are used and no forbidden label appears in rules', () => {
  const result = validate();
  assert.deepEqual(result.warnings, []);
  for (const forbidden of contract.forbidden_labels) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(rulesYaml),
      `rules contain forbidden label ${forbidden}`,
    );
  }
});
