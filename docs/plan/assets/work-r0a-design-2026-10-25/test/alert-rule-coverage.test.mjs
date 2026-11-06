// 2026-11-07 (C17): the rules file defines 27 alerts; the behaviour cases in
// prometheus-rules.test.yml covered 10 of them, and nothing anywhere said so. `promtool test rules`
// returning SUCCESS on that file therefore meant "the cases that exist pass", not "the alerting
// contract is tested" - the same shape as a green suite that silently skips half the surface.
// promtool enforces these cases in CI (work-r0a-gates.yml:245-249 runs check + test rules), so this
// node guard pins the other half - coverage. Every alert must have both directions on file - one case that expects it to
// fire and one that expects it to stay off - and no case may name an alert that does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OPS_DIR = join(HERE, '..', '..', 'work-r0a-ops-2026-10-25');
const RULES = readFileSync(join(OPS_DIR, 'prometheus-rules.yaml'), 'utf8');
const CASES = readFileSync(join(OPS_DIR, 'prometheus-rules.test.yml'), 'utf8');

// alert definitions live on `  - alert: Name` lines inside the rules groups
const defined = [...new Set([...RULES.matchAll(/^\s*-\s+alert:\s*"?([A-Za-z0-9_]+)"?\s*$/gm)].map((m) => m[1]))];
assert.ok(defined.length >= 20,
  `only ${defined.length} alerts parsed from prometheus-rules.yaml; the parser or the file changed shape, ` +
  'and a coverage guard that reads an empty set proves nothing');

// each behaviour case is an `alertname:` line paired with either a populated exp_alerts or []
const firings = new Set();
const stays = new Set();
const caseLines = CASES.split(/\r?\n/);
for (let i = 0; i < caseLines.length; i += 1) {
  const name = caseLines[i].match(/^\s*alertname:\s+([A-Za-z0-9_]+)\s*$/);
  if (!name) continue;
  let j = i + 1;
  while (j < caseLines.length && !/^\s*exp_alerts:/.test(caseLines[j])) j += 1;
  assert.ok(j < caseLines.length, `case ${name[1]} has no exp_alerts block at all`);
  const empty = /^\s*exp_alerts:\s*\[\]\s*$/.test(caseLines[j]);
  if (empty) stays.add(name[1]); else firings.add(name[1]);
}

test('every defined alert has a firing case and a stays-off case', () => {
  const missingFire = defined.filter((n) => !firings.has(n));
  const missingStay = defined.filter((n) => !stays.has(n));
  assert.deepEqual(missingFire, [], `${missingFire.length} alert(s) never have a case that expects them to fire`);
  assert.deepEqual(missingStay, [], `${missingStay.length} alert(s) never have a below-threshold case, ` +
    'so a rule that fires on everything would still pass promtool');
});

test('no case names an alert the rules no longer define', () => {
  const used = new Set([...firings, ...stays]);
  const unknown = [...used].filter((n) => !defined.includes(n));
  assert.deepEqual(unknown, [],
    `cases exist for ${unknown.join(', ')} which prometheus-rules.yaml does not define - the alert was ` +
    'renamed or dropped and the test file is now asserting a name that can never fire');
});

test('the coverage is reported, so the next reader does not have to re-derive it', () => {
  console.log(`prometheus alert coverage: ${defined.length} defined, ` +
    `${firings.size} with firing cases, ${stays.size} with stays-off cases`);
  assert.equal(firings.size, defined.length);
  assert.equal(stays.size, defined.length);
});
