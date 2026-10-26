/**
 * Telemetry rules-as-code for the R0a pilot.
 *
 * The contract is the source of truth; this module validates it against
 * slo-pilot.json, checks runbook anchors, and renders deterministic Prometheus
 * recording/alert rules. It does not claim any metric is being scraped.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = path.join(HERE, 'telemetry-contract.json');
export const SLO_PATH = path.join(HERE, 'slo-pilot.json');
export const RULES_PATH = path.join(HERE, 'prometheus-rules.yaml');
export const DOCS_ROOT = path.resolve(HERE, '..', '..');

const METRIC_NAME = /^work_[a-z0-9_]+$/;
const RECORD_NAME = /^work:(?:slo|track)_[a-z0-9_]+:[a-z0-9_]+$/;
const ALERT_NAME = /^Work[A-Za-z0-9]+$/;
const SEVERITIES = new Set(['page', 'ticket']);

function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function runbookAnchors(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const anchors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) anchors.add(slugify(heading[2]));
  }
  return anchors;
}

function checkRunbook(value, errors, field) {
  if (typeof value !== 'string' || !value.includes('.md')) {
    errors.push(`${field}: runbook must be a markdown path`);
    return;
  }
  const [filePart, anchor] = value.split('#');
  const file = path.resolve(DOCS_ROOT, filePart);
  if (!fs.existsSync(file)) {
    errors.push(`${field}: runbook file missing: ${filePart}`);
    return;
  }
  if (anchor) {
    const anchors = runbookAnchors(file);
    if (!anchors?.has(anchor)) {
      errors.push(`${field}: runbook anchor missing: ${filePart}#${anchor}`);
    }
  }
}

function selectorLabels(expr) {
  const labels = new Set();
  for (const match of expr.matchAll(/\{([^}]*)\}/g)) {
    for (const label of match[1].matchAll(/([a-zA-Z_][\w]*)\s*(?:=~|!~|!=|=)/g)) {
      labels.add(label[1]);
    }
  }
  return labels;
}

function exprMetrics(expr) {
  const names = new Set();
  for (const match of expr.matchAll(/\b(work_[a-z0-9_]+)\b/g)) {
    names.add(match[1]);
  }
  return names;
}

function exprRecords(expr) {
  const names = new Set();
  for (const match of expr.matchAll(/\b(work:(?:slo|track)_[a-z0-9_]+:[a-z0-9_]+)\b/g)) {
    names.add(match[1]);
  }
  return names;
}

function checkExpr(expr, contract, recordNames, errors, field) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    errors.push(`${field}: expression is empty`);
    return;
  }
  for (const metric of exprMetrics(expr)) {
    if (!contract.metrics[metric]) {
      errors.push(`${field}: undeclared metric ${metric}`);
    }
  }
  for (const record of exprRecords(expr)) {
    if (!recordNames.has(record)) {
      errors.push(`${field}: undeclared recording rule ${record}`);
    }
  }
  for (const label of selectorLabels(expr)) {
    if (contract.forbidden_labels.includes(label)) {
      errors.push(`${field}: forbidden label ${label}`);
    }
    if (!contract.labels_allowlist.includes(label)) {
      errors.push(`${field}: label ${label} is not in labels_allowlist`);
    }
  }
  if (expr.includes('histogram_quantile') && !expr.includes('_bucket')) {
    errors.push(`${field}: histogram_quantile must read a *_bucket metric`);
  }
}

export function validateTelemetry({ contract, slos, rulesYaml = '' }) {
  const errors = [];
  const warnings = [];

  if (contract.version !== 'r0a-telemetry-v1') {
    errors.push('contract: unexpected version');
  }
  if (!Array.isArray(contract.slos) || !Array.isArray(contract.operational_alerts)) {
    errors.push('contract: slos and operational_alerts must be arrays');
    return { errors, warnings, summary: null };
  }

  const sloById = new Map(slos.metrics.map((metric) => [metric.id, metric]));
  const contractIds = new Set();
  const recordNames = new Set();
  const alertNames = new Set();
  const usedMetrics = new Set();

  for (const [name, metric] of Object.entries(contract.metrics)) {
    if (!METRIC_NAME.test(name)) errors.push(`metrics.${name}: invalid metric name`);
    if (!['counter', 'gauge', 'histogram'].includes(metric.type)) {
      errors.push(`metrics.${name}: invalid type`);
    }
    if (!Array.isArray(metric.labels) || metric.labels.length === 0) {
      errors.push(`metrics.${name}: labels must be a non-empty array`);
      continue;
    }
    if (metric.type === 'histogram' && !metric.labels.includes('le')) {
      errors.push(`metrics.${name}: histogram must declare le`);
    }
    for (const label of metric.labels) {
      if (contract.forbidden_labels.includes(label)) {
        errors.push(`metrics.${name}: forbidden label ${label}`);
      }
      if (!contract.labels_allowlist.includes(label)) {
        errors.push(`metrics.${name}: label ${label} is not in labels_allowlist`);
      }
    }
  }

  for (const entry of contract.slos) {
    if (contractIds.has(entry.id)) errors.push(`slos: duplicate id ${entry.id}`);
    contractIds.add(entry.id);
    const slo = sloById.get(entry.id);
    if (!slo) {
      errors.push(`slos.${entry.id}: no matching SLO in slo-pilot.json`);
    } else {
      if (entry.target !== slo.target) {
        errors.push(`slos.${entry.id}: target ${entry.target} != slo-pilot ${slo.target}`);
      }
      if (entry.unit !== slo.unit) {
        errors.push(`slos.${entry.id}: unit ${entry.unit} != slo-pilot ${slo.unit}`);
      }
      if (entry.window !== slo.window) {
        errors.push(`slos.${entry.id}: window ${entry.window} != slo-pilot ${slo.window}`);
      }
    }
    if (entry.track_only !== (entry.target === null)) {
      errors.push(`slos.${entry.id}: track_only must equal (target === null)`);
    }
    if (!Array.isArray(entry.recording) || entry.recording.length === 0) {
      errors.push(`slos.${entry.id}: at least one recording rule is required`);
    }
    for (const [index, record] of (entry.recording ?? []).entries()) {
      const field = `slos.${entry.id}.recording[${index}]`;
      if (!RECORD_NAME.test(record.record ?? '')) {
        errors.push(`${field}: invalid record name ${record.record}`);
      }
      if (recordNames.has(record.record)) {
        errors.push(`${field}: duplicate record name ${record.record}`);
      }
      recordNames.add(record.record);
      if (entry.track_only && !record.record.startsWith('work:track_')) {
        errors.push(`${field}: track-only record must start with work:track_`);
      }
      if (!entry.track_only && !record.record.startsWith('work:slo_')) {
        errors.push(`${field}: SLO record must start with work:slo_`);
      }
      checkExpr(record.expr, contract, recordNames, errors, field);
      for (const metric of exprMetrics(record.expr ?? '')) usedMetrics.add(metric);
    }

    const alerts = entry.alerts ?? [];
    for (const [index, alert] of alerts.entries()) {
      const field = `slos.${entry.id}.alerts[${index}]`;
      if (!ALERT_NAME.test(alert.name ?? '')) errors.push(`${field}: invalid alert name`);
      if (alertNames.has(alert.name)) errors.push(`${field}: duplicate alert ${alert.name}`);
      alertNames.add(alert.name);
      if (!SEVERITIES.has(alert.severity)) errors.push(`${field}: invalid severity`);
      if (typeof alert.for !== 'string' || !/^\d+[smhd]$/.test(alert.for)) {
        errors.push(`${field}: invalid for duration`);
      }
      if (typeof alert.summary !== 'string' || !alert.summary.trim()) {
        errors.push(`${field}: summary is required`);
      }
      checkRunbook(alert.runbook, errors, field);
      checkExpr(alert.expr, contract, recordNames, errors, field);
      for (const metric of exprMetrics(alert.expr ?? '')) usedMetrics.add(metric);
      if (entry.track_only && alert.slo_alert === true) {
        errors.push(`${field}: track-only SLO must not emit an SLO alert`);
      }
    }
    if (!entry.track_only && !alerts.some((alert) => alert.slo_alert === true)) {
      errors.push(`slos.${entry.id}: non-track-only SLO needs an SLO alert`);
    }
  }

  for (const id of sloById.keys()) {
    if (!contractIds.has(id)) errors.push(`slos: missing telemetry for ${id}`);
  }

  for (const [index, alert] of contract.operational_alerts.entries()) {
    const field = `operational_alerts[${index}]`;
    if (!ALERT_NAME.test(alert.name ?? '')) errors.push(`${field}: invalid alert name`);
    if (alertNames.has(alert.name)) errors.push(`${field}: duplicate alert ${alert.name}`);
    alertNames.add(alert.name);
    if (!SEVERITIES.has(alert.severity)) errors.push(`${field}: invalid severity`);
    if (alert.slo_alert !== false) {
      errors.push(`${field}: operational alert must not claim an SLO alert`);
    }
    checkRunbook(alert.runbook, errors, field);
    checkExpr(alert.expr, contract, recordNames, errors, field);
    for (const metric of exprMetrics(alert.expr ?? '')) usedMetrics.add(metric);
  }

  for (const name of Object.keys(contract.metrics)) {
    if (!usedMetrics.has(name)) warnings.push(`metrics.${name}: declared but unused`);
  }

  for (const record of recordNames) {
    if (!rulesYaml.includes(record)) errors.push(`rules: missing recording rule ${record}`);
  }
  for (const alert of alertNames) {
    if (!rulesYaml.includes(alert)) errors.push(`rules: missing alert ${alert}`);
  }
  for (const forbidden of contract.forbidden_labels) {
    if (new RegExp(`\\b${forbidden}\\b`).test(rulesYaml)) {
      errors.push(`rules: forbidden label ${forbidden} appears in rules`);
    }
  }

  return {
    errors,
    warnings,
    summary: {
      slos: contract.slos.length,
      trackOnly: contract.slos.filter((entry) => entry.track_only).length,
      records: recordNames.size,
      alerts: alertNames.size,
      metrics: Object.keys(contract.metrics).length,
    },
  };
}

export function renderRules(contract) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(contract))
    .digest('hex');
  const lines = [
    '# AUTO-GENERATED by generate-telemetry.mjs from telemetry-contract.json.',
    `# Contract SHA-256: ${hash}`,
    '# Do not edit by hand.',
    'groups:',
    '  - name: work-r0a-slo-recording',
    '    interval: 30s',
    '    rules:',
  ];

  for (const entry of contract.slos) {
    for (const record of entry.recording) {
      lines.push(`      - record: ${JSON.stringify(record.record)}`);
      lines.push('        expr: |');
      for (const exprLine of record.expr.split('\n')) {
        lines.push(`          ${exprLine}`);
      }
      lines.push('        labels:');
      lines.push(`          slo: ${JSON.stringify(entry.id)}`);
      lines.push(
        `          mode: ${JSON.stringify(entry.track_only ? 'track_only' : 'slo')}`,
      );
    }
  }

  lines.push('  - name: work-r0a-alerts');
  lines.push('    rules:');
  const alerts = [
    ...contract.slos.flatMap((entry) =>
      entry.alerts.map((alert) => ({ ...alert, slo: entry.id })),
    ),
    ...contract.operational_alerts.map((alert) => ({ ...alert, slo: 'operational' })),
  ];
  for (const alert of alerts) {
    lines.push(`      - alert: ${JSON.stringify(alert.name)}`);
    lines.push('        expr: |');
    for (const exprLine of alert.expr.split('\n')) {
      lines.push(`          ${exprLine}`);
    }
    lines.push(`        for: ${JSON.stringify(alert.for)}`);
    lines.push('        labels:');
    lines.push(`          severity: ${JSON.stringify(alert.severity)}`);
    lines.push(`          slo: ${JSON.stringify(alert.slo)}`);
    lines.push(
      `          alert_class: ${JSON.stringify(alert.slo_alert ? 'slo' : 'operational')}`,
    );
    lines.push('        annotations:');
    lines.push(`          summary: ${JSON.stringify(alert.summary)}`);
    lines.push('          org_id: "{{ $labels.org_id }}"');
    lines.push(`          runbook: ${JSON.stringify(alert.runbook)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function loadTelemetry() {
  return {
    contract: JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')),
    slos: JSON.parse(fs.readFileSync(SLO_PATH, 'utf8')),
    rulesYaml: fs.existsSync(RULES_PATH) ? fs.readFileSync(RULES_PATH, 'utf8') : '',
  };
}
