// Operational documents hand duty engineers SQL. If a document names a table that the
// shipped schema does not have, the operator finds out on the worst night - and there was
// exactly such a query until 2026-11-04: runbook section 5.2 told duty staff to run
//   SELECT kind, max(last_success) FROM work_background_job_last_success GROUP BY kind;
// while `work_background_job_last_success` exists only as a *metric* name
// (telemetry-contract.json, prometheus-rules.yaml, background-jobs.contract.ts). No table in
// the migration chain is named *job* at all, so that "值班第一步" could never run.
//
// Scope is the copy-pasteable text: in Markdown that means fenced blocks (these documents use
// bare ``` fences) and inline `code spans`; in .sql files every line except comment text.
// SQL that appears inside bash is included on purpose - that is how a runbook tells someone
// to run psql. The relation list comes from the newest catalog snapshot, generated from a real
// PostgreSQL at the current chain head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..'); // docs/plan
const WORK_ROOT = join(PLAN_DIR, '..', '..', 'src', 'work');

const DOC_SOURCES = [
  [join('assets', 'work-r0a-ops-2026-10-25', 'README.md'), PLAN_DIR],
  [join('assets', 'work-r0a-design-2026-10-25', 'README.md'), PLAN_DIR],
  ['work-operations-runbook-2026-10-25.md', PLAN_DIR],
  ['work-r0a-drill-checklist-2026-11-15.md', PLAN_DIR],
  ['work-r0a-data-design-2026-10-25.md', PLAN_DIR],
  ...readdirSync(join(WORK_ROOT, 'scripts')).filter((n) => n.endsWith('.sql')).map((n) => [n, join(WORK_ROOT, 'scripts')]),
  // The deployed shell wrappers hold the psql invocations an operator actually copies.
  ...readdirSync(join(WORK_ROOT, 'scripts')).filter((n) => n.endsWith('.sh')).map((n) => [n, join(WORK_ROOT, 'scripts')]),
  ...readdirSync(join(WORK_ROOT, 'deploy', 'ecs')).filter((n) => n.endsWith('.sh')).map((n) => [n, join(WORK_ROOT, 'deploy', 'ecs')]),
];

const CATALOG_DIR = join(WORK_ROOT, 'migrations', 'catalogs');
const catalogFiles = readdirSync(CATALOG_DIR).filter((name) => name.endsWith('.json')).sort();
assert.ok(catalogFiles.length >= 20, `expected the migration catalog snapshots to exist (found ${catalogFiles.length})`);
const head = catalogFiles[catalogFiles.length - 1];
const catalog = JSON.parse(readFileSync(join(CATALOG_DIR, head), 'utf8'));

function relationNames(node) {
  const out = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) out.add(value.replace(/"/g, '').toLowerCase());
  };
  if (Array.isArray(node)) {
    for (const item of node) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add(item.relation ?? item.table ?? item.name);
    }
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      add(key);
      if (value && typeof value === 'object') add(value.name ?? value.relation ?? value.table);
    }
  }
  return out;
}

const tables = new Set([...relationNames(catalog.relations), ...relationNames(catalog.views)]);
const bareNames = new Set([...tables].map((name) => name.split('.').pop()));
assert.ok(bareNames.size >= 40, `catalog ${head} yielded only ${bareNames.size} relations - an empty parse would pass every check below`);

const KEYWORDS = new Set([
  'select', 'the', 'what', 'where', 'it', 'this', 'only', 'lateral', 'values', 'unnest',
  'now', 'generate_series', 'work', 'information_schema', 'read', 'a', 'an', 'dual', 'skip',
  'locked', 'share', 'exclusive', // `FOR UPDATE SKIP LOCKED` is a lock clause, not a table
  'group', 'order', 'using', 'as', 'on', 'and', 'or', 'left', 'right', 'inner', 'cross',
  'full', 'join', 'from', 'into', 'update', 'set', 'with', 'case', 'when', 'then',
  'postgres', 'alpine', 'node', 'ubuntu', 'debian', 'python', 'psql', 'dapper', 'template',
  'commit', // rollout scripts say "install ... from commit <sha>" - a revision, not a table
]);

// work.schema_migration is the migrate tool's own ledger table: created in
// internal/migrate/ledger.go and deliberately filtered out of every catalog query
// (internal/migrate/catalog.go:149,174,203,231,310,333,365), so it never appears in the
// relation list above even though the rollout/verify scripts legitimately read it.
const TOOL_OWNED_TABLES = new Set(['work.schema_migration', 'schema_migration']);

const REF = /\b(?:from|join|update|into)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
const CTE = /\b([a-z_][a-z0-9_]*)\s+as\s+(?:materialized\s*)?\(/gi;
const ALIAS = /\b(?:from|join)\s+([a-z_][a-z0-9_.]*)\s+(?:as\s+)?([a-z_][a-z0-9_]*)/gi;
const EXEMPT = /schema-ref-exempt/;
const FENCE = /^\s*```/;
const INLINE = /`([^`]+)`/g;

// Code units to scan: [text, lineNumber]. In Markdown these are fenced-block lines and inline
// code spans; in SQL files, comment-stripped lines. Dockerfile-style leading FROM lines are not
// table references, so a unit whose first word is FROM is dropped.
function codeUnits(text, kind) {
  const units = [];
  if (kind === 'sql') {
    text.split(/\r?\n/).forEach((line, index) => units.push([line.replace(/--.*$/, ''), index + 1]));
    return units;
  }
  if (kind === 'sh') {
    return text
      .split(/\r?\n/)
      .map((line, index) => [line.replace(/(^|[^"\\])#.*$/, '$1'), index + 1]);
  }
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) units.push([line, index + 1]);
    for (const span of line.matchAll(INLINE)) units.push([span[1], index + 1]);
  });
  return units.filter(([unit]) => !/^\s*from\b/i.test(unit));
}

const unresolved = [];
let scanned = 0;
let filesWithSql = 0;

for (const [relative, base] of DOC_SOURCES) {
  const text = readFileSync(join(base, relative), 'utf8');
  const kind = relative.endsWith('.md') ? 'md' : relative.endsWith('.sql') ? 'sql' : 'sh';
  const local = new Set([...text.matchAll(CTE)].map((m) => m[1].toLowerCase()));
  for (const match of text.matchAll(ALIAS)) {
    const target = match[1].toLowerCase();
    const alias = match[2].toLowerCase();
    if ((tables.has(target) || bareNames.has(target.split('.').pop()) || local.has(target)) && !KEYWORDS.has(alias)) {
      local.add(alias);
    }
  }
  let counted = 0;
  const exemptLines = new Set(
    text.split(/\r?\n/).map((line, index) => (EXEMPT.test(line) ? index + 1 : 0)).filter((n) => n > 0),
  );
  for (const [unit, number] of codeUnits(text, kind)) {
    // The marker is a Markdown comment on the same line, so it is checked per line rather
    // than inside the extracted code span.
    if (exemptLines.has(number)) continue;
    for (const match of unit.matchAll(REF)) {
      const raw = match[1].toLowerCase();
      if (KEYWORDS.has(raw) || raw.startsWith('pg_') || raw.startsWith('information_schema')) continue;
      scanned += 1;
      counted += 1;
      const qualifier = raw.includes('.') ? raw.split('.')[0] : null;
      if (qualifier && local.has(qualifier)) continue; // `pub.created_at` where pub is a CTE/alias
      if (local.has(raw)) continue;
      if (TOOL_OWNED_TABLES.has(raw) || TOOL_OWNED_TABLES.has(raw.split('.').pop())) continue;
      if (tables.has(raw) || bareNames.has(raw.split('.').pop())) continue;
      unresolved.push(`${relative}:${number} -> ${raw}`);
    }
  }
  if (counted > 0) filesWithSql += 1;
  if (process.env.DSR_DEBUG) console.log(`DSR ${relative} refs=${counted}`);
}

test('the SQL-bearing operator documents and the catalog chain head are both real', () => {
  assert.match(head, /^00\d\d_/, `unexpected catalog file name ${head}`);
  assert.ok(filesWithSql >= 3, `expected at least 3 of the ${DOC_SOURCES.length} sources to carry copy-pasteable SQL, found ${filesWithSql}`);
  assert.ok(scanned >= 40, `only ${scanned} table references scanned - a fence or pattern that stopped matching would silently pass every check below`);
});

test('every table named in copy-pasteable operator SQL exists in the shipped schema', () => {
  assert.deepEqual(unresolved, [], `dangling table references (an operator would hit an error on duty day): ${unresolved.join(', ')}`);
});
