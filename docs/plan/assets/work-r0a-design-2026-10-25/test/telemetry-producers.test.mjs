// C17's real shape, pinned instead of paraphrased.
//
// promtool validates that a rule is well-formed; it cannot say whether the series the rule
// queries exists anywhere. This checks that: every work_* identifier used by the alert rules is
// either emitted by code under src/ or listed below as knowingly unproduced.
//
// As of 2026-11-04 that list is the entire contract - 28 names, and none of them appears in any
// Go, Python or TypeScript source. So "SLO rules wired into CI" is accurate, and "alerts will
// fire when the pilot degrades" is not: a recording rule over absent series yields no data, and
// an alert over no data does not page. That is a different gap from the checklist's wording
// ("no Prometheus scrape, dashboards or Alertmanager delivery on real series"), because it does
// not close by deploying a scraper.
//
// The list is a ratchet, not a to-do memo: wiring an emitter means deleting its name here, and
// the second test fails while a produced metric is still listed. Both directions are checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ASSET_DIR = new URL('../../work-r0a-ops-2026-10-25/', import.meta.url);
const SRC_DIR = new URL('../../../../../src/', import.meta.url);

const CONTRACT = JSON.parse(readFileSync(new URL('telemetry-contract.json', ASSET_DIR), 'utf8'));
const RULES_TEXT = readFileSync(new URL('prometheus-rules.yaml', ASSET_DIR), 'utf8');

// Names the rules query and no code emits yet. Derived from the contract on 2026-11-04 by
// searching every work_* identifier in prometheus-rules.yaml against src/; kept written out so
// removing one is an edit someone has to make on purpose.
const UNPRODUCED = [
  'work_api_requests_total',
  'work_api_request_duration_seconds_bucket',
  'work_status_visible_seconds_bucket',
  'work_first_screen_seconds_bucket',
  'work_model_ttft_seconds_bucket',
  'work_outbox_lag_seconds_bucket',
  'work_unknown_operation_age_minutes_bucket',
  'work_quota_reconciliation_diff_tokens',
  'work_quota_unsettled_reservations',
  'work_runs_total',
  'work_task_events_total',
  'work_sse_events_total',
  'work_provider_requests_total',
  'work_workflow_start_total',
  'work_outbox_backlog_events',
  'work_unknown_operations',
  'work_unknown_operation_age_minutes_max',
  'work_outbox_dead_letters',
  'work_usage_settlements_total',
  'work_background_job_runs_total',
  'work_background_job_last_success_seconds',
  'work_background_job_lease_takeovers_total',
  'work_directory_projection_lag_seconds',
  'work_audit_export_backlog',
  'work_audit_export_downloads_total',
  'work_content_shred_backlog',
  'work_audit_export_duration_seconds_sum',
  'work_audit_export_duration_seconds_count',
];

const SOURCE_EXTENSIONS = ['.go', '.py', '.ts', '.tsx', '.mjs'];

const SRC_ROOT = fileURLToPath(SRC_DIR);
// readdirSync recursive returns every path under src/, so nothing here depends on resolving
// directory URLs by hand - the first version of this test did, walked the wrong places, and the
// file-count floor below is what exposed it instead of letting an empty scan pass as clean.
const FILES = readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf8' }).filter(
  (relative) =>
    !relative.includes('node_modules') &&
    !relative.includes('styled-system') &&
    !relative.includes(`${'/' }dist/`) &&
    SOURCE_EXTENSIONS.some((ext) => relative.endsWith(ext)),
);

// One pass over the tree, so the check does not re-read every file per metric name and does not
// build a multi-megabyte concatenation in memory.
const PRODUCED = new Set();
{
  const names = new Set([...UNPRODUCED, ...(RULES_TEXT.match(/\bwork_[a-z0-9_]+\b/g) ?? [])]);
  for (const relative of FILES) {
    const text = readFileSync(join(SRC_ROOT, relative), 'utf8');
    for (const name of names) {
      if (text.includes(name)) PRODUCED.add(name);
    }
  }
}

test('the source scan looked at a real tree, so an empty result is not a path mistake', () => {
  assert.ok(
    FILES.length >= 500,
    `expected at least 500 source files under src, found ${FILES.length} - the producer scan ` +
      'would otherwise pass by reading nothing',
  );
});

test('every metric the rules query is either produced or listed as unproduced', () => {
  const referenced = new Set(RULES_TEXT.match(/\bwork_[a-z0-9_]+\b/g) ?? []);
  assert.ok(
    referenced.size >= 20,
    `expected at least 20 distinct work_* identifiers in prometheus-rules.yaml, found ` +
      `${referenced.size} - the rule file or this parser changed shape`,
  );
  // telemetry-contract.json keys its metrics by series name, so this is Object.keys, not a map
  // over an array.
  const contractNames = new Set(Object.keys(CONTRACT.metrics));
  for (const name of UNPRODUCED) {
    assert.ok(
      contractNames.has(name),
      `${name} is listed as unproduced but is no longer in telemetry-contract.json`,
    );
  }
  // Recording rules define their own series, so those names are produced by the rule file
  // itself rather than by a scrape target.
  const recorded = new Set(
    [...RULES_TEXT.matchAll(/record:\s*([A-Za-z_:][\w:]*)/g)].map((match) => match[1]),
  );
  const unaccounted = [...referenced].filter(
    (name) => !UNPRODUCED.includes(name) && !recorded.has(name) && !PRODUCED.has(name),
  );
  assert.deepEqual(
    unaccounted,
    [],
    'these series are queried by an alert rule with no emitter in src/ and no entry in the ' +
      'unproduced list - the alert cannot fire on data that nothing writes',
  );
});

test('the unproduced list shrinks as emitters land', () => {
  const producedWhileListed = UNPRODUCED.filter((name) => PRODUCED.has(name));
  assert.deepEqual(
    producedWhileListed,
    [],
    'these metrics now have an emitter in src/; delete them from UNPRODUCED so the real gap ' +
      'stays a count, not prose',
  );
});
