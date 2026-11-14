// Code-side guard for the Work Go test surface and its CI coverage.
// Historically this gate also pinned prose readings in work-glossary.md / the runbook (suite counts,
// hand-copied CI line windows). Those doc citations were removed when the long design docs were
// archived: live numbers belong to the generator (scripts/work-status.mjs) and the suite itself,
// not to hand-maintained prose. What remains is everything derivable from the tree and the workflow:
// the package universe, the no-test count, the single-module/no-build-constraint assumptions, and
// the fact that CI really runs promtool and the serial full suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..'); // docs/plan
const REPO = join(PLAN_DIR, '..', '..');
const WORK_ROOT = join(REPO, 'src', 'work');
const GATES_WF = join(REPO, '.github', 'workflows', 'work-r0a-gates.yml');

function walkDirs(dir, out = []) {
  out.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    walkDirs(join(dir, entry.name), out);
  }
  return out;
}

const allDirs = walkDirs(WORK_ROOT);
const moduleRoots = allDirs
  .filter((dir) => readdirSync(dir).includes('go.mod'))
  .map((dir) => dir.slice(WORK_ROOT.length + 1));

// Universe predicate: a directory holding any .go file is a package; a package directory with no
// _test.go file is what the suite prints as "[no test files]". Release payload copies are walked too,
// because ./... would include them.
const byDir = new Map();
for (const dir of allDirs) {
  const goFiles = readdirSync(dir).filter((name) => name.endsWith('.go'));
  if (goFiles.length) byDir.set(dir, goFiles.map((name) => join(dir, name)));
}
const universe = [...byDir.keys()].sort();
const withoutTests = universe.filter((dir) => !byDir.get(dir).some((f) => f.endsWith('_test.go')));

// A directory scan stands in for `go test ./...` only while every test file builds into a test
// binary on the machine running the suite. Build-constrained test files break that equivalence.
const constrained = [];
for (const files of byDir.values()) {
  for (const file of files.filter((f) => f.endsWith('_test.go'))) {
    const head = readFileSync(file, 'utf8').split('\n').slice(0, 6).join('\n');
    if (/^\/\/go:build\s/m.test(head) || /^\/\/ \+build\s/m.test(head)) constrained.push(file);
  }
}

test('the tree is one module and no test file is build-constrained, so the scan is ./... itself', () => {
  assert.deepEqual(moduleRoots, [''],
    `expected exactly one go.mod, at src/work; found ${JSON.stringify(moduleRoots)} - a nested module is invisible to ./... and this gate's counts would stop matching the suite`);
  assert.ok(universe.length >= 45,
    `derived only ${universe.length} package directories under src/work - refusing to treat a partial scan as the universe`);
  assert.deepEqual(constrained, [],
    `${constrained.length} test file(s) carry //go:build or // +build lines; such a directory has tests yet can print "[no test files]" on some platforms, which is exactly the predicate this gate derives`);
});

test('the derived package universe and no-test count are non-empty', () => {
  assert.ok(withoutTests.length >= 5,
    `derived only ${withoutTests.length} packages without test files - an empty set would make the derivation meaningless`);
  assert.ok(withoutTests.length < universe.length,
    'every package has tests? then the no-test derivation has nothing to guard');
});

test('CI still runs promtool against the shipped rules', () => {
  assert.ok(existsSync(GATES_WF), `${GATES_WF} is gone; CI promtool enforcement needs re-pointing`);
  const wf = readFileSync(GATES_WF, 'utf8');
  assert.match(wf, /^ *- name: .*promtool/m, 'no promtool step in work-r0a-gates.yml - CI stopped enforcing rule syntax');
  assert.match(wf, /promtool (check|test) rules/, 'no promtool invocation in work-r0a-gates.yml');
});

test('CI go-migrate job still runs the serial full suite', () => {
  assert.ok(existsSync(GATES_WF), `${GATES_WF} is gone`);
  const wf = readFileSync(GATES_WF, 'utf8').split('\n');
  const start = wf.findIndex((line) => /^ {2}go-migrate:$/.test(line)) + 1;
  assert.ok(start > 0, 'no go-migrate job key in work-r0a-gates.yml');
  let end = wf.length;
  for (let i = start; i < wf.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(wf[i])) { end = i; break; }
  }
  const body = wf.slice(start - 1, end).join('\n');
  assert.ok(body.includes('go test ./... -p 1 -count=1'),
    `the go-migrate job (lines ${start}-${end}) no longer runs the serial full suite; "CI runs it" would be prose again`);
});