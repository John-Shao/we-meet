// Gate for the "活库串行全量" readings in docs/plan/work-glossary.md row 2.
// Two numbers lived in that cell from different trees ("36 包 ok" and "10 无测试"), which add up
// to 46 while the module has 47 packages: one side was a day stale and nothing looked at it.
// The suite itself cannot be run here (it needs a live PostgreSQL), so this gate pins only what IS
// derivable from the tree - the package universe and the count of packages without test files -
// and requires the suite-side numbers to stay attached to a dated reading plus the command that
// prints them. The last two tests derive citation windows from the workflow file itself and require
// the doc citations to carry them: the promtool pointer read `gates.yml:245-249` (no such file in
// the repo, two lines past the step) and the go-migrate pointer had drifted off the job's real
// window, so both were hand-copied numbers pretending to be readings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..'); // docs/plan
const REPO = join(PLAN_DIR, '..', '..');
const WORK_ROOT = join(REPO, 'src', 'work');
const GLOSSARY = join(PLAN_DIR, '..', 'work', 'design', 'work-glossary.md');
const RUNBOOK = join(PLAN_DIR, '..', 'work', 'design', 'work-operations-runbook-2026-10-25.md');
const WORK_PROJECT = join(PLAN_DIR, '..', 'work', 'work-project.md');
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

// Universe predicate kept identical to the one that produced the reading: a directory holding any
// .go file is a package, and a package directory with no _test.go file is what the suite prints as
// "[no test files]". Release payload copies are walked too, because ./... would include them.
const byDir = new Map();
for (const dir of allDirs) {
  const goFiles = readdirSync(dir).filter((name) => name.endsWith('.go'));
  if (goFiles.length) byDir.set(dir, goFiles.map((name) => join(dir, name)));
}
const universe = [...byDir.keys()].sort();
const withoutTests = universe.filter((dir) => !byDir.get(dir).some((f) => f.endsWith('_test.go')));

// A directory scan stands in for `go test ./...` only while every test file builds into a test
// binary on the machine running the suite. Build-constrained test files break that equivalence, so
// the assumption is asserted rather than trusted.
const constrained = [];
for (const files of byDir.values()) {
  for (const file of files.filter((f) => f.endsWith('_test.go'))) {
    const head = readFileSync(file, 'utf8').split('\n').slice(0, 6).join('\n');
    if (/^\/\/go:build\s/m.test(head) || /^\/\/ \+build\s/m.test(head)) constrained.push(file);
  }
}

const glossaryLines = readFileSync(GLOSSARY, 'utf8').split('\n');
const row2 = glossaryLines.find((line) => /^\|\s*2\s*\|\s*单元／契约／活库测试/.test(line));

test('the tree is one module and no test file is build-constrained, so the scan is ./... itself', () => {
  assert.deepEqual(moduleRoots, [''],
    `expected exactly one go.mod, at src/work; found ${JSON.stringify(moduleRoots)} - a nested module is invisible to ./... and this gate's counts would stop matching the suite`);
  assert.ok(universe.length >= 45,
    `derived only ${universe.length} package directories under src/work - refusing to treat a partial scan as the universe`);
  assert.deepEqual(constrained, [],
    `${constrained.length} test file(s) carry //go:build or // +build lines; such a directory has tests yet can print "[no test files]" on some platforms, which is exactly the predicate this gate derives`);
});

test('the derived no-test count is the number the status source states as its derivation', () => {
  assert.ok(row2, 'work-glossary.md no longer has the row 2 cell this gate reads');
  assert.ok(withoutTests.length >= 5,
    `derived only ${withoutTests.length} packages without test files - an empty set would make the comparison meaningless`);
  const marked = row2.match(/静态派生无测试包 \*\*(\d+)／(\d+)\*\*/);
  assert.ok(marked,
    'row 2 must state the derivation as "静态派生无测试包 **N／M**" so the number has a producer instead of a copyist');
  assert.equal(Number(marked[1]), withoutTests.length,
    `row 2 states ${marked[1]} packages without test files, the tree derives ${withoutTests.length} (${withoutTests.map((d) => d.slice(WORK_ROOT.length + 1)).join(', ')})`);
  assert.equal(Number(marked[2]), universe.length,
    `row 2 states ${marked[2]} package directories, the tree derives ${universe.length}`);
});

test('the suite-side numbers in row 2 stay attached to a dated reading and its take command', () => {
  assert.match(row2, /【\d{4}-\d{2}-\d{2} 现读】活库串行全量 \*\*\d+ ok／\d+ FAIL／\d+ 无测试\*\*/,
    'row 2 must keep a dated live-suite reading in that exact shape; the undated 36／10 pair is what went stale');
  assert.ok(row2.includes('go test ./... -p 1 -count=1'),
    'row 2 must carry the command that prints those suite counts, otherwise the cell is a copy and not a reading');
  const suite = row2.match(/【\d{4}-\d{2}-\d{2} 现读】活库串行全量 \*\*(\d+) ok／(\d+) FAIL／(\d+) 无测试\*\*/);
  assert.equal(Number(suite[3]), withoutTests.length,
    `the dated suite reading says ${suite[3]} no-test packages while the tree derives ${withoutTests.length} - one of the two belongs to another commit`);
});

test('promtool is cited by the window derived from the workflow file, not by hand', () => {
  assert.ok(existsSync(GATES_WF), `${GATES_WF} is gone; this gate and both doc citations need re-pointing`);
  const wf = readFileSync(GATES_WF, 'utf8').split('\n');
  const start = wf.findIndex((line) => /^ *- name: .*promtool/.test(line)) + 1;
  assert.ok(start > 0, 'no promtool step in work-r0a-gates.yml - either CI stopped enforcing it or this gate points at the wrong file');
  let end = 0;
  wf.forEach((line, i) => {
    if (i + 1 >= start && line.includes('promtool ')) end = i + 1;
  });
  assert.ok(end > start, `no promtool invocation below step line ${start}`);
  const citation = `work-r0a-gates.yml:${start}-${end}`;
  const cited = glossaryLines.filter((line) => line.includes('promtool') && /yml:\d+-\d+/.test(line));
  assert.ok(cited.length >= 2,
    `expected the two promtool citations in work-glossary.md to stay present, saw ${cited.length}`);
  for (const line of cited) {
    assert.ok(line.includes(citation),
      `a promtool citation in work-glossary.md does not carry ${citation} as derived from the workflow file itself`);
  }
});

// The runbook tells duty staff that CI runs the serial full suite and cites the go-migrate job by
// line window. That window was written when the file was shorter (198-226) and has since drifted,
// so it is derived here the same way, and the citation also has to keep pointing at a job that
// really still runs `go test ./... -p 1 -count=1` - otherwise "CI runs it" is prose again.
test('the go-migrate citation in the runbook points at the derived job window and still contains the serial suite', () => {
  assert.ok(existsSync(RUNBOOK), `${RUNBOOK} is gone; the go-migrate citation this gate pins lives there`);
  const wf = readFileSync(GATES_WF, 'utf8').split('\n');
  const start = wf.findIndex((line) => /^ {2}go-migrate:$/.test(line)) + 1;
  assert.ok(start > 0, 'no go-migrate job key in work-r0a-gates.yml');
  let end = wf.length;
  for (let i = start; i < wf.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(wf[i])) { end = i; break; }
  }
  const body = wf.slice(start - 1, end).join('\n');
  assert.ok(body.includes('go test ./... -p 1 -count=1'),
    `the go-migrate job (lines ${start}-${end}) no longer runs the serial full suite; the runbook sentence that says CI runs it has to change with it`);
  const citation = `work-r0a-gates.yml:${start}-${end}`;
  const cited = readFileSync(RUNBOOK, 'utf8').split('\n')
    .concat(glossaryLines)
    .concat(readFileSync(WORK_PROJECT, 'utf8').split('\n'))
    .filter((line) => line.includes('go-migrate') && /yml:\d+-\d+/.test(line));
  assert.ok(cited.length >= 1,
    'no doc line cites the go-migrate job by window any more; if CI coverage of the serial suite is no longer claimed anywhere, delete this test on purpose rather than let it pass over nothing');
  for (const line of cited) {
    assert.ok(line.includes(citation),
      `a go-migrate citation does not carry ${citation} as derived from the workflow file (the window moves whenever the file grows; that is why it is not copied by hand)`);
  }
});
