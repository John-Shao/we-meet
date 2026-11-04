// #53 (2026-11-04): a count(*) over an RLS-forced table is not "no rows" - it is "no rows
// this session may see". `FORCE ROW LEVEL SECURITY` applies to the table owner too, so reading
// `work.run` as work_owner without setting `app.org_id` returns 0 and looks exactly like an empty
// database. That is how a "production was reset" conclusion got written down today, and it nearly
// ended in cancelling user tasks. The catalogue snapshot says which tables are force-protected;
// this gate checks every copy-pasteable aggregate over those tables declares a tenant context,
// a superuser connection, or a SECURITY DEFINER command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..');
const WORK_ROOT = join(PLAN_DIR, '..', '..', 'src', 'work');
const CATALOG_DIR = join(WORK_ROOT, 'migrations', 'catalogs');

const catalogFiles = readdirSync(CATALOG_DIR).filter((n) => n.endsWith('.json')).sort();
const head = catalogFiles[catalogFiles.length - 1];
const catalog = JSON.parse(readFileSync(join(CATALOG_DIR, head), 'utf8'));
const forced = new Set((catalog.relations || [])
  .filter((r) => r && r.rls === true && r.force_rls === true)
  .map((r) => r.name));

const SOURCES = [
  join(PLAN_DIR, 'work-operations-runbook-2026-10-25.md'),
  join(PLAN_DIR, 'work-r0a-drill-checklist-2026-11-15.md'),
  join(PLAN_DIR, 'assets', 'work-r0a-design-2026-10-25', 'README.md'),
  join(PLAN_DIR, 'assets', 'work-r0a-ops-2026-10-25', 'README.md'),
  join(PLAN_DIR, 'work-r0a-data-design-2026-10-25.md'),
  ...readdirSync(join(WORK_ROOT, 'scripts')).map((n) => join(WORK_ROOT, 'scripts', n)),
  ...readdirSync(join(WORK_ROOT, 'deploy', 'ecs')).filter((n) => n.endsWith('.sh')).map((n) => join(WORK_ROOT, 'deploy', 'ecs', n)),
].filter((p) => { try { return readFileSync(p) && true; } catch { return false; } });

const REF = /\b(?:from|into|update)\s+work\.([a-z_]+)/gi;
const AGG = /count\(\*\)|\bmax\(|\bsum\(|group by/i;
const CONTEXT = /app\.org_id|set_config\(|\bwork\.[a-z_]+\s*\(/i;
const SUPERUSER = /-U postgres|runuser -u postgres|sudo -u postgres/i;

// Units that are allowed to violate the rule, with a reason. An entry whose unit is gone
// must be deleted, so this list cannot silently accumulate stale exemptions.
const NEEDS_NO_CONTEXT = [];

const violations = [];
const staleAllow = [];
const allowSeen = new Set();
let aggregateUnits = 0;
let superuserFiles = 0;

for (const path of SOURCES) {
  const text = readFileSync(path, 'utf8');
  const label = basename(path);
  const isMarkdown = label.endsWith('.md');
  // A Markdown mention of `runuser -u postgres` is an instruction to the reader, not this file's own
  // connection - exempting on it would blank the whole document. Scripts do open real connections.
  const fileSuperuser = !isMarkdown && SUPERUSER.test(text);
  if (fileSuperuser) superuserFiles += 1;
  const units = [];
  if (isMarkdown) {
    let inFence = false;
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }
      if (inFence) units.push([line, index + 1, '']);
      // An inline span is quoted by the prose around it, so the sentence counts as its declaration;
      // a fenced block stands on its own and gets no host line.
      for (const span of line.matchAll(/`([^`]+)`/g)) units.push([span[1], index + 1, line]);
    });
  } else {
    text.split(/\r?\n/).forEach((line, index) => units.push([line.replace(/(^|[^"\\])#.*$/, '$1'), index + 1, '']));
  }
  for (const [unit, number, hostLine] of units) {
    const tables = new Set([...unit.matchAll(REF)].map((m) => m[1].toLowerCase()));
    const hits = [...tables].filter((t) => forced.has(t));
    if (hits.length === 0 || !AGG.test(unit)) continue;
    aggregateUnits += 1;
    // A script whose psql helper runs as the postgres superuser is legitimately unfiltered;
    // RLS does not apply there, so the statement needs no tenant GUC.
    if (fileSuperuser || CONTEXT.test(unit) || CONTEXT.test(hostLine) || SUPERUSER.test(hostLine)) {
      const listed = NEEDS_NO_CONTEXT.find((e) => e.file === label && unit.includes(e.contains));
      if (listed) allowSeen.add(listed.contains);
      continue;
    }
    const listed = NEEDS_NO_CONTEXT.find((e) => e.file === label && unit.includes(e.contains));
    if (listed) { allowSeen.add(listed.contains); continue; }
    violations.push(`${label}:${number} tables=${hits.join(',')} :: ${unit.trim().slice(0, 100)}`);
  }
}

test('the force-RLS table set and the aggregate-unit sample are both real', () => {
  assert.ok(forced.size >= 40, `catalog ${head} marks only ${forced.size} force-RLS tables - a broken parse would pass everything below`);
  assert.ok(aggregateUnits >= 6, `found ${aggregateUnits} aggregate units over force-RLS tables; the extractor or the corpus changed, which would make this gate vacuous`);
  assert.ok(superuserFiles >= 2, `expected at least 2 sources to connect as the postgres superuser (the verify scripts do) - found ${superuserFiles}`);
});

test('every aggregate over a force-RLS table declares how it sees rows', () => {
  assert.deepEqual(violations, [], `counts that can silently read 0 rows instead of real data:\n${violations.join('\n')}`);
});

test('the runbook keeps the zero-rows-is-not-empty discipline', () => {
  const rb = readFileSync(join(PLAN_DIR, 'work-operations-runbook-2026-10-25.md'), 'utf8');
  assert.ok(rb.includes('零行不等于无数据'), 'the §5.2 warning naming the 2026-11-04 misjudgment was removed');
  assert.ok(/reltuples|n_live_tup/.test(rb), 'the cross-check via pg_class.reltuples / pg_stat_user_tables.n_live_tup disappeared');
  assert.ok(rb.includes('app.org_id'), 'the requirement to SET app.org_id for owner-view reads disappeared');
});

for (const entry of NEEDS_NO_CONTEXT) {
  if (!allowSeen.has(entry.contains)) staleAllow.push(entry.contains);
}
test('the exemption list carries no dead entries', () => {
  assert.deepEqual(staleAllow, [], `exemptions whose unit no longer exists: ${staleAllow.join(', ')} - delete them`);
});
